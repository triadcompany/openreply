import { prisma } from "@/lib/db/client";
import { getDMQueue, FUNNEL_JOB_NAME, type ProcessFunnelJob } from "@/lib/queue/client";
import {
  createInstagramContext,
  getUserFollowStatus,
  hasInstagramCredentials,
  sendButtonMessage,
  type InstagramContext,
} from "@/lib/instagram/provider";
import { reserveDMSlot, releaseDMSlot } from "@/lib/utils/rate-limiter";
import {
  releaseWorkspaceDMReservation,
  reserveWorkspaceDMSend,
} from "@/lib/billing/usage";
import { buildTrackedUrl } from "@/lib/tracking/message";
import { generateTrackedLinkSlug, hashRecipientId } from "@/lib/tracking/server";
import { step, type FunnelEffect, type FunnelEvent } from "./engine";
import {
  OPEN_STATUSES,
  advanceRun,
  createRun,
  finishRun,
  loadPublishedGraph,
  toRunState,
} from "./runs";

/**
 * Performs what the pure interpreter (engine.ts) decides: sends messages,
 * schedules timers and checks follow status. Every entry point ends in
 * handleFunnelEvent, which advances the run first and only then acts, so a
 * duplicate tap or a stale timer can never send twice.
 */

// Instagram does not report a brand-new follow right away, so a "not following"
// answer is re-checked after these delays before it is believed. Same knob and
// default as the fixed follow gate in dm-worker.ts.
const FOLLOW_RECHECK_DELAYS_MS = (
  process.env.FOLLOW_RECHECK_DELAYS_MS ?? "20000,40000"
)
  .split(",")
  .map(Number)
  .filter((ms) => ms > 0);

type LoadedRun = NonNullable<Awaited<ReturnType<typeof loadRun>>>;

async function loadRun(runId: string) {
  return prisma.funnelRun.findUnique({
    where: { id: runId },
    include: { automation: { include: { instagramAccount: true } } },
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function contextFor(run: LoadedRun, operation: string): Promise<InstagramContext | null> {
  const account = run.automation.instagramAccount;
  if (!hasInstagramCredentials(account)) return null;
  try {
    return await createInstagramContext(account, `funnel:${run.id}:${operation}`);
  } catch {
    return null;
  }
}

async function trackedUrl(run: LoadedRun, button: { label: string; url: string }) {
  const where = { automationId: run.automationId, destinationUrl: button.url };
  let slug = (await prisma.trackedLink.findFirst({ where, select: { slug: true } }))?.slug;
  if (!slug) {
    slug = generateTrackedLinkSlug();
    await prisma.trackedLink.create({
      data: {
        workspaceId: run.automation.workspaceId,
        automationId: run.automationId,
        slug,
        label: button.label,
        destinationUrl: button.url,
        position: await prisma.trackedLink.count({ where: { automationId: run.automationId } }),
      },
    });
  }
  return buildTrackedUrl(slug, undefined, hashRecipientId(run.userId));
}

async function logDm(
  run: LoadedRun,
  commentId: string,
  text: string,
  data: { status: "SENT" | "FAILED" | "SKIPPED_PLAN_LIMIT" | "SKIPPED_RATE_LIMIT"; errorMessage?: string }
) {
  const base = {
    status: data.status,
    errorMessage: data.errorMessage ?? null,
    attempts: 1,
    ...(data.status === "SENT" ? { dmSentAt: new Date() } : {}),
  };
  await prisma.dmLog.upsert({
    where: { automationId_commentId: { automationId: run.automationId, commentId } },
    create: {
      workspaceId: run.automation.workspaceId,
      automationId: run.automationId,
      instagramAccountId: run.automation.instagramAccountId,
      commenterId: run.userId,
      commenterName: run.username,
      commentText: text.slice(0, 500),
      commentId,
      ...base,
    },
    update: base,
  });
}

/** Sends one funnel message. Returns false (and ends the run) when it could not go out. */
async function sendMessage(
  run: LoadedRun,
  effect: Extract<FunnelEffect, { type: "send_message" }>
): Promise<boolean> {
  const isFirst = !run.firstMessageSent && Boolean(run.commentId);
  const logId = isFirst ? run.commentId! : `fn:${run.id}:${effect.nodeId}:${Date.now()}`;
  const fail = async (status: "FAILED" | "SKIPPED_PLAN_LIMIT" | "SKIPPED_RATE_LIMIT", reason: string) => {
    await logDm(run, logId, effect.text, { status, errorMessage: reason });
    await finishRun(run.id, "FAILED", reason);
    return false;
  };

  const context = await contextFor(run, effect.nodeId);
  if (!context) return fail("FAILED", "Conta do Instagram sem credenciais.");

  const usage = await reserveWorkspaceDMSend(run.automation.workspaceId);
  if (!usage.allowed) return fail("SKIPPED_PLAN_LIMIT", `Limite mensal de DMs atingido (${usage.limit}).`);

  const instagramId = run.automation.instagramAccount.instagramId;
  let slot;
  try {
    slot = await reserveDMSlot(instagramId, 0);
  } catch (error) {
    await releaseWorkspaceDMReservation(run.automation.workspaceId, usage.periodStart);
    return fail("FAILED", errorText(error));
  }
  if (!slot.allowed) {
    await releaseWorkspaceDMReservation(run.automation.workspaceId, usage.periodStart);
    return fail("SKIPPED_RATE_LIMIT", "Limite por hora de DMs do Instagram atingido.");
  }

  try {
    const buttons = await Promise.all(
      effect.buttons.map(async (button) =>
        button.kind === "link"
          ? { type: "url" as const, title: button.label, url: await trackedUrl(run, button) }
          : {
              type: "postback" as const,
              title: button.label,
              payload: `fn:${run.id}:${effect.nodeId}:${button.id}`,
            }
      )
    );
    await sendButtonMessage({
      context,
      instagramAccountId: instagramId,
      commentId: isFirst ? run.commentId! : undefined,
      userId: run.userId,
      text: effect.text,
      buttons,
    });
  } catch (error) {
    await releaseDMSlot(instagramId);
    await releaseWorkspaceDMReservation(run.automation.workspaceId, usage.periodStart);
    return fail("FAILED", errorText(error));
  }

  await logDm(run, logId, effect.text, { status: "SENT" });
  if (isFirst) {
    await prisma.funnelRun.update({ where: { id: run.id }, data: { firstMessageSent: true } });
  }
  return true;
}

async function scheduleJob(run: LoadedRun, event: ProcessFunnelJob["event"], delayMs: number) {
  await getDMQueue().add(
    FUNNEL_JOB_NAME,
    { runId: run.id, instagramAccountId: run.automation.instagramAccount.instagramId, event },
    {
      delay: delayMs,
      // Unique per call: the same block can be reached again in a loop.
      jobId: `fn_${run.id}_${event.nodeId}_${event.type}_${Date.now()}`,
    }
  );
}

async function checkFollow(run: LoadedRun, nodeId: string, attempt: number) {
  const context = await contextFor(run, `follow:${nodeId}`);
  let follows: boolean | null = null;
  if (context) {
    try {
      follows = await getUserFollowStatus({ context, recipientId: run.userId });
    } catch {
      follows = null;
    }
  }
  if (follows === false && attempt < FOLLOW_RECHECK_DELAYS_MS.length) {
    await scheduleJob(run, { type: "follow_recheck", nodeId, attempt: attempt + 1 }, FOLLOW_RECHECK_DELAYS_MS[attempt]);
    return;
  }
  await handleFunnelEvent(run.id, { type: "follow_result", nodeId, follows });
}

async function perform(run: LoadedRun, effects: FunnelEffect[]) {
  for (const effect of effects) {
    switch (effect.type) {
      case "send_message":
        if (!(await sendMessage(run, effect))) return;
        break;
      case "schedule_timer":
        await scheduleJob(run, { type: "timeout", nodeId: effect.nodeId }, effect.delayMinutes * 60_000);
        break;
      case "check_follow":
        await checkFollow(run, effect.nodeId, 0);
        break;
      case "complete":
      case "fail":
        // Already persisted with the new run state.
        break;
    }
  }
}

/** Feeds one event to a run: step, persist (winner only), then act. */
export async function handleFunnelEvent(
  runId: string,
  event: FunnelEvent,
  options: { userInitiated?: boolean } = {}
): Promise<void> {
  const run = await loadRun(runId);
  if (!run || !OPEN_STATUSES.includes(run.status)) return;

  const graph = await loadPublishedGraph(run.funnelId, run.version);
  if (!graph) {
    await finishRun(run.id, "FAILED", "Versão publicada do funil não encontrada ou inválida.");
    return;
  }

  const now = new Date();
  if (!options.userInitiated && event.type !== "start" && now > run.windowExpiresAt) {
    await finishRun(run.id, "EXPIRED", "Janela de 24 h da Meta encerrada.");
    return;
  }

  const from = toRunState(run);
  const result = step(graph, from, event, { username: run.username ?? undefined });
  if (result.ignored) return;

  const failure = result.effects.find((effect) => effect.type === "fail");
  const won = await advanceRun({
    runId: run.id,
    from,
    to: result.run,
    userInteractedAt: options.userInitiated ? now : undefined,
    failureReason: failure?.type === "fail" ? failure.reason : undefined,
  });
  if (!won) return;

  await perform(run, result.effects);
}

/**
 * A campaign trigger (comment or DM) hands the conversation to the campaign's
 * funnel. "no_funnel" means the campaign should run its fixed flow instead.
 */
export async function startFunnelForTrigger(input: {
  automation: { id: string; funnelId: string | null };
  instagramAccountId: string;
  userId: string;
  username?: string | null;
  /** Set for comment triggers: the first message is a private reply to it. */
  commentId?: string | null;
  /** Dedupe key: the comment id, or "dm:<message id>". */
  triggerKey: string;
}): Promise<"started" | "busy" | "no_funnel"> {
  const { automation } = input;
  if (!automation.funnelId) return "no_funnel";

  const funnel = await prisma.funnel.findUnique({
    where: { id: automation.funnelId },
    select: { id: true, publishedVersion: true },
  });
  if (!funnel?.publishedVersion) return "no_funnel";
  const graph = await loadPublishedGraph(funnel.id, funnel.publishedVersion);
  if (!graph) return "no_funnel";

  // The same trigger can be queued twice (webhook and polling sweep, or a retry).
  const seen = await prisma.funnelRun.findFirst({
    where: { automationId: automation.id, userId: input.userId, triggerKey: input.triggerKey },
    select: { id: true },
  });
  if (seen) return "busy";

  const run = await createRun({
    funnelId: funnel.id,
    version: funnel.publishedVersion,
    graph,
    automationId: automation.id,
    instagramAccountId: input.instagramAccountId,
    userId: input.userId,
    username: input.username,
    commentId: input.commentId,
    triggerKey: input.triggerKey,
  });
  if (!run) return "busy";

  await handleFunnelEvent(run.id, { type: "start" });
  return "started";
}

export async function handleFunnelPostback(input: {
  payload: string;
  userId: string;
  instagramAccountId: string;
}): Promise<void> {
  const [, runId, nodeId, buttonId] = input.payload.split(":");
  if (!runId || !nodeId || !buttonId) return;
  const run = await prisma.funnelRun.findUnique({
    where: { id: runId },
    select: { userId: true, automation: { select: { instagramAccount: { select: { instagramId: true } } } } },
  });
  // The payload comes from a button we sent, but check it belongs to this person and account.
  if (
    !run ||
    run.userId !== input.userId ||
    run.automation.instagramAccount.instagramId !== input.instagramAccountId
  ) {
    return;
  }
  await handleFunnelEvent(runId, { type: "button", nodeId, buttonId }, { userInitiated: true });
}

/** Returns true when the text was a reply a funnel was waiting for. */
export async function handleFunnelReply(input: {
  instagramAccountId: string;
  senderId: string;
  text: string;
}): Promise<boolean> {
  const run = await prisma.funnelRun.findFirst({
    where: {
      userId: input.senderId,
      status: "WAITING_REPLY",
      automation: { instagramAccount: { instagramId: input.instagramAccountId } },
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true, currentNodeId: true, version: true, funnelId: true },
  });
  if (!run) return false;

  const graph = await loadPublishedGraph(run.funnelId, run.version);
  const node = graph?.nodes.find((candidate) => candidate.id === run.currentNodeId);
  if (node?.type !== "await_reply") return false;

  await handleFunnelEvent(run.id, { type: "reply", text: input.text }, { userInitiated: true });
  return true;
}

export async function handleFunnelJob(data: ProcessFunnelJob): Promise<void> {
  const { runId, event } = data;
  if (event.type === "timeout") {
    await handleFunnelEvent(runId, event);
    return;
  }
  const run = await loadRun(runId);
  if (!run || run.status !== "ACTIVE" || run.currentNodeId !== event.nodeId) return;
  await checkFollow(run, event.nodeId, event.attempt);
}
