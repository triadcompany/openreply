import { prisma } from "@/lib/db/client";
import { Prisma } from "@/app/generated/prisma/client";
import { funnelGraphSchema, type FunnelGraph } from "./graph";
import { initialRun, type RunState, type RunStatus } from "./engine";

// Instagram only allows messaging someone within 24 hours of their last interaction.
export const WINDOW_MS = 24 * 60 * 60 * 1000;

export const OPEN_STATUSES: RunStatus[] = ["ACTIVE", "WAITING_REPLY", "WAITING_TIMER"];

export function windowEnd(from: Date): Date {
  return new Date(from.getTime() + WINDOW_MS);
}

export async function loadPublishedGraph(
  funnelId: string,
  version: number
): Promise<FunnelGraph | null> {
  const row = await prisma.funnelVersion.findUnique({
    where: { funnelId_version: { funnelId, version } },
    select: { graph: true },
  });
  const parsed = funnelGraphSchema.safeParse(row?.graph);
  return parsed.success ? parsed.data : null;
}

/**
 * Starts a run unless the person already has an unfinished one for this
 * campaign (the partial unique index decides, so two webhooks racing cannot
 * both start). Returns null in that case.
 */
export async function createRun(input: {
  funnelId: string;
  version: number;
  graph: FunnelGraph;
  automationId: string;
  instagramAccountId: string;
  userId: string;
  username?: string | null;
  commentId?: string | null;
  triggerKey?: string | null;
}) {
  const now = new Date();
  const state = initialRun(input.graph);
  try {
    return await prisma.funnelRun.create({
      data: {
        funnelId: input.funnelId,
        version: input.version,
        automationId: input.automationId,
        instagramAccountId: input.instagramAccountId,
        userId: input.userId,
        username: input.username ?? null,
        commentId: input.commentId ?? null,
        triggerKey: input.triggerKey ?? null,
        currentNodeId: state.currentNodeId,
        status: state.status,
        variables: state.variables,
        lastInteractionAt: now,
        windowExpiresAt: windowEnd(now),
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return null;
    }
    throw error;
  }
}

export function toRunState(run: {
  currentNodeId: string;
  status: RunStatus;
  variables: unknown;
  lastReply: string | null;
}): RunState {
  const variables =
    run.variables && typeof run.variables === "object" && !Array.isArray(run.variables)
      ? (run.variables as Record<string, string>)
      : {};
  return {
    currentNodeId: run.currentNodeId,
    status: run.status,
    variables,
    ...(run.lastReply ? { lastReply: run.lastReply } : {}),
  };
}

/**
 * Moves a run from one position to the next, only if nobody moved it first.
 * Two taps on the same button, or a stale timer racing a tap, both read the
 * same "from" position and exactly one wins; the loser must not send anything.
 */
export async function advanceRun(input: {
  runId: string;
  from: Pick<RunState, "currentNodeId" | "status">;
  to: RunState;
  userInteractedAt?: Date;
  failureReason?: string;
}): Promise<boolean> {
  const result = await prisma.funnelRun.updateMany({
    where: {
      id: input.runId,
      currentNodeId: input.from.currentNodeId,
      status: input.from.status,
    },
    data: {
      currentNodeId: input.to.currentNodeId,
      status: input.to.status,
      variables: input.to.variables,
      lastReply: input.to.lastReply ?? null,
      ...(input.userInteractedAt
        ? {
            lastInteractionAt: input.userInteractedAt,
            windowExpiresAt: windowEnd(input.userInteractedAt),
          }
        : {}),
      ...(input.failureReason ? { failureReason: input.failureReason } : {}),
    },
  });
  return result.count === 1;
}

export async function finishRun(
  runId: string,
  status: Extract<RunStatus, "EXPIRED" | "FAILED" | "COMPLETED">,
  failureReason?: string
) {
  await prisma.funnelRun.updateMany({
    where: { id: runId, status: { in: OPEN_STATUSES } },
    data: { status, ...(failureReason ? { failureReason } : {}) },
  });
}
