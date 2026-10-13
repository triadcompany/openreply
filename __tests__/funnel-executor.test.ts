import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FunnelGraph } from "../lib/funnel/graph";

const pos = { x: 0, y: 0 };
const graph: FunnelGraph = {
  nodes: [
    { id: "s", type: "start", position: pos, data: {} },
    {
      id: "welcome",
      type: "message",
      position: pos,
      data: {
        text: "Oi {username}",
        buttons: [
          { id: "yes", kind: "reply", label: "Quero" },
          { id: "site", kind: "link", label: "Site", url: "https://example.com" },
        ],
        timeoutMinutes: 30,
      },
    },
    { id: "follow", type: "follow_check", position: pos, data: {} },
    { id: "thanks", type: "message", position: pos, data: { text: "Valeu", buttons: [] } },
    { id: "nope", type: "message", position: pos, data: { text: "Segue a gente", buttons: [] } },
    { id: "reminder", type: "message", position: pos, data: { text: "Ainda quer?", buttons: [] } },
    { id: "end", type: "end", position: pos, data: {} },
  ],
  edges: [
    { id: "1", source: "s", sourceHandle: "next", target: "welcome" },
    { id: "2", source: "welcome", sourceHandle: "button:yes", target: "follow" },
    { id: "3", source: "welcome", sourceHandle: "timeout", target: "reminder" },
    { id: "4", source: "follow", sourceHandle: "follows", target: "thanks" },
    { id: "5", source: "follow", sourceHandle: "not_follows", target: "nope" },
    { id: "6", source: "thanks", sourceHandle: "next", target: "end" },
    { id: "7", source: "nope", sourceHandle: "next", target: "end" },
    { id: "8", source: "reminder", sourceHandle: "next", target: "end" },
  ],
};

const m = vi.hoisted(() => ({
  prisma: {
    funnelRun: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    funnelVersion: { findUnique: vi.fn() },
    funnel: { findUnique: vi.fn() },
    trackedLink: { findFirst: vi.fn(), create: vi.fn(), count: vi.fn() },
    dmLog: { upsert: vi.fn() },
  },
  queueAdd: vi.fn(),
  sendButtonMessage: vi.fn(),
  getUserFollowStatus: vi.fn(),
  reserveSlot: vi.fn(),
  releaseSlot: vi.fn(),
  reserveUsage: vi.fn(),
  releaseUsage: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: m.prisma }));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: m.queueAdd }),
  FUNNEL_JOB_NAME: "process-funnel",
}));
vi.mock("@/lib/instagram/provider", () => ({
  createInstagramContext: vi.fn().mockResolvedValue({ provider: "META", accessToken: "token" }),
  hasInstagramCredentials: () => true,
  sendButtonMessage: m.sendButtonMessage,
  getUserFollowStatus: m.getUserFollowStatus,
}));
vi.mock("@/lib/utils/rate-limiter", () => ({
  reserveDMSlot: m.reserveSlot,
  releaseDMSlot: m.releaseSlot,
}));
vi.mock("@/lib/billing/usage", () => ({
  reserveWorkspaceDMSend: m.reserveUsage,
  releaseWorkspaceDMReservation: m.releaseUsage,
}));

import {
  handleFunnelEvent,
  handleFunnelJob,
  handleFunnelPostback,
  startFunnelForTrigger,
} from "../lib/funnel/executor";

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "run1",
    funnelId: "f1",
    version: 1,
    automationId: "a1",
    userId: "u1",
    username: "ana",
    commentId: "c1",
    triggerKey: "c1",
    currentNodeId: "s",
    status: "ACTIVE",
    variables: {},
    lastReply: null,
    firstMessageSent: false,
    windowExpiresAt: new Date(Date.now() + 3_600_000),
    automation: {
      workspaceId: "w1",
      instagramAccountId: "conn1",
      instagramAccount: { instagramId: "ig1", provider: "META", accessToken: "x", zernioAccountId: null, workspaceId: "w1" },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.prisma.funnelVersion.findUnique.mockResolvedValue({ graph });
  m.prisma.funnelRun.updateMany.mockResolvedValue({ count: 1 });
  m.prisma.trackedLink.findFirst.mockResolvedValue({ slug: "abc" });
  m.reserveUsage.mockResolvedValue({ allowed: true, limit: 1000, periodStart: new Date() });
  m.reserveSlot.mockResolvedValue({ allowed: true });
  m.sendButtonMessage.mockResolvedValue({ message_id: "mid" });
});

describe("funnel executor", () => {
  it("sends the first message as a private reply and schedules the no-interaction timer", async () => {
    m.prisma.funnelRun.findUnique.mockResolvedValue(runRow());
    await handleFunnelEvent("run1", { type: "start" });

    expect(m.sendButtonMessage).toHaveBeenCalledOnce();
    const sent = m.sendButtonMessage.mock.calls[0][0];
    expect(sent).toMatchObject({ commentId: "c1", userId: "u1", text: "Oi ana" });
    expect(sent.buttons).toEqual([
      { type: "postback", title: "Quero", payload: "fn:run1:welcome:yes" },
      { type: "url", title: "Site", url: expect.stringContaining("/r/abc?r=") },
    ]);
    expect(m.prisma.funnelRun.update).toHaveBeenCalledWith({
      where: { id: "run1" },
      data: { firstMessageSent: true },
    });
    expect(m.queueAdd).toHaveBeenCalledWith(
      "process-funnel",
      expect.objectContaining({ runId: "run1", event: { type: "timeout", nodeId: "welcome" } }),
      expect.objectContaining({ delay: 30 * 60_000 })
    );
    // The first message is logged on the comment's own DM log row.
    expect(m.prisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { automationId_commentId: { automationId: "a1", commentId: "c1" } },
      })
    );
  });

  it("sends later messages as direct messages, not as a second private reply", async () => {
    m.prisma.funnelRun.findUnique.mockResolvedValue(
      runRow({ currentNodeId: "welcome", status: "WAITING_REPLY", firstMessageSent: true })
    );
    m.getUserFollowStatus.mockResolvedValue(true);
    await handleFunnelEvent("run1", { type: "follow_result", nodeId: "welcome", follows: true });
    // wrong node for the event: nothing happens
    expect(m.sendButtonMessage).not.toHaveBeenCalled();

    m.prisma.funnelRun.findUnique.mockResolvedValue(
      runRow({ currentNodeId: "follow", status: "ACTIVE", firstMessageSent: true })
    );
    await handleFunnelEvent("run1", { type: "follow_result", nodeId: "follow", follows: true });
    expect(m.sendButtonMessage.mock.calls[0][0]).toMatchObject({ commentId: undefined, text: "Valeu" });
  });

  it("does nothing when another worker already moved the run (lost race)", async () => {
    m.prisma.funnelRun.findUnique.mockResolvedValue(
      runRow({ currentNodeId: "welcome", status: "WAITING_REPLY", firstMessageSent: true })
    );
    m.prisma.funnelRun.updateMany.mockResolvedValue({ count: 0 });
    await handleFunnelEvent("run1", { type: "button", nodeId: "welcome", buttonId: "yes" }, { userInitiated: true });
    expect(m.sendButtonMessage).not.toHaveBeenCalled();
    expect(m.queueAdd).not.toHaveBeenCalled();
  });

  it("expires a timer that fires after the 24 hour window", async () => {
    m.prisma.funnelRun.findUnique.mockResolvedValue(
      runRow({
        currentNodeId: "welcome",
        status: "WAITING_REPLY",
        firstMessageSent: true,
        windowExpiresAt: new Date(Date.now() - 1000),
      })
    );
    await handleFunnelEvent("run1", { type: "timeout", nodeId: "welcome" });
    expect(m.sendButtonMessage).not.toHaveBeenCalled();
    expect(m.prisma.funnelRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "EXPIRED" }) })
    );
  });

  it("ends the run and logs the reason when Instagram rejects a send", async () => {
    m.prisma.funnelRun.findUnique.mockResolvedValue(runRow());
    m.sendButtonMessage.mockRejectedValue(new Error("Meta is down"));
    await handleFunnelEvent("run1", { type: "start" });
    expect(m.releaseSlot).toHaveBeenCalled();
    expect(m.releaseUsage).toHaveBeenCalled();
    expect(m.prisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ status: "FAILED", errorMessage: "Meta is down" }) })
    );
    expect(m.queueAdd).not.toHaveBeenCalled();
  });

  it("re-checks a 'not following' answer before believing it", async () => {
    m.prisma.funnelRun.findUnique.mockResolvedValue(
      runRow({ currentNodeId: "welcome", status: "WAITING_REPLY", firstMessageSent: true })
    );
    m.getUserFollowStatus.mockResolvedValue(false);
    await handleFunnelEvent("run1", { type: "button", nodeId: "welcome", buttonId: "yes" }, { userInitiated: true });
    expect(m.queueAdd).toHaveBeenCalledWith(
      "process-funnel",
      expect.objectContaining({ event: { type: "follow_recheck", nodeId: "follow", attempt: 1 } }),
      expect.objectContaining({ delay: 20_000 })
    );
    expect(m.sendButtonMessage).not.toHaveBeenCalled();
  });

  it("only acts on a follow re-check while the run is still waiting on that block", async () => {
    m.prisma.funnelRun.findUnique.mockResolvedValue(runRow({ currentNodeId: "thanks", status: "ACTIVE" }));
    await handleFunnelJob({
      instagramAccountId: "ig1",
      runId: "run1",
      event: { type: "follow_recheck", nodeId: "follow", attempt: 1 },
    });
    expect(m.getUserFollowStatus).not.toHaveBeenCalled();
  });

  it("ignores a button payload that belongs to someone else", async () => {
    m.prisma.funnelRun.findUnique.mockResolvedValue({
      userId: "someone-else",
      automation: { instagramAccount: { instagramId: "ig1" } },
    });
    await handleFunnelPostback({ payload: "fn:run1:welcome:yes", userId: "u1", instagramAccountId: "ig1" });
    expect(m.prisma.funnelRun.updateMany).not.toHaveBeenCalled();
  });
});

describe("starting a funnel from a trigger", () => {
  const automation = { id: "a1", funnelId: "f1" };
  const trigger = { automation, instagramAccountId: "conn1", userId: "u1", username: "ana", commentId: "c1", triggerKey: "c1" };

  it("falls back to the fixed flow without a linked, published funnel", async () => {
    expect(await startFunnelForTrigger({ ...trigger, automation: { id: "a1", funnelId: null } })).toBe("no_funnel");
    m.prisma.funnel.findUnique.mockResolvedValue({ id: "f1", publishedVersion: null });
    expect(await startFunnelForTrigger(trigger)).toBe("no_funnel");
  });

  it("does not start a second run for the same trigger", async () => {
    m.prisma.funnel.findUnique.mockResolvedValue({ id: "f1", publishedVersion: 1 });
    m.prisma.funnelRun.findFirst.mockResolvedValue({ id: "old" });
    expect(await startFunnelForTrigger(trigger)).toBe("busy");
    expect(m.prisma.funnelRun.create).not.toHaveBeenCalled();
  });

  it("reports busy when the person already has an unfinished run", async () => {
    m.prisma.funnel.findUnique.mockResolvedValue({ id: "f1", publishedVersion: 1 });
    m.prisma.funnelRun.findFirst.mockResolvedValue(null);
    const { Prisma } = await import("../app/generated/prisma/client");
    m.prisma.funnelRun.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "7" })
    );
    expect(await startFunnelForTrigger(trigger)).toBe("busy");
  });
});
