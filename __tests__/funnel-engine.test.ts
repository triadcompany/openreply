import { describe, expect, it } from "vitest";
import { initialRun, step, type RunState } from "../lib/funnel/engine";
import type { FunnelGraph } from "../lib/funnel/graph";

const pos = { x: 0, y: 0 };

// start -> welcome (2 reply buttons, 30 min "no interaction" exit)
//   "yes"     -> follow? -> link / ask-follow
//   "no"      -> end
//   timeout   -> reminder -> end
const graph: FunnelGraph = {
  nodes: [
    { id: "s", type: "start", position: pos, data: {} },
    {
      id: "welcome",
      type: "message",
      position: pos,
      data: {
        text: "Oi {username}!",
        buttons: [
          { id: "yes", kind: "reply", label: "Quero" },
          { id: "no", kind: "reply", label: "Agora não" },
        ],
        timeoutMinutes: 30,
      },
    },
    { id: "follow", type: "follow_check", position: pos, data: {} },
    {
      id: "link",
      type: "message",
      position: pos,
      data: {
        text: "Aqui o link",
        buttons: [{ id: "l", kind: "link", label: "Abrir", url: "https://example.com" }],
      },
    },
    { id: "ask", type: "message", position: pos, data: { text: "Segue a gente", buttons: [] } },
    {
      id: "reminder",
      type: "message",
      position: pos,
      data: { text: "Ainda quer?", buttons: [] },
    },
    { id: "end", type: "end", position: pos, data: {} },
  ],
  edges: [
    { id: "1", source: "s", sourceHandle: "next", target: "welcome" },
    { id: "2", source: "welcome", sourceHandle: "button:yes", target: "follow" },
    { id: "3", source: "welcome", sourceHandle: "button:no", target: "end" },
    { id: "4", source: "welcome", sourceHandle: "timeout", target: "reminder" },
    { id: "5", source: "follow", sourceHandle: "follows", target: "link" },
    { id: "6", source: "follow", sourceHandle: "not_follows", target: "ask" },
    { id: "7", source: "link", sourceHandle: "next", target: "end" },
    { id: "8", source: "ask", sourceHandle: "next", target: "end" },
    { id: "9", source: "reminder", sourceHandle: "next", target: "end" },
  ],
};

function started(): { run: RunState; effects: ReturnType<typeof step>["effects"] } {
  return step(graph, initialRun(graph), { type: "start" }, { username: "ana" });
}

describe("funnel engine", () => {
  it("sends the first message, waits for a tap and schedules the no-interaction timer", () => {
    const { run, effects } = started();
    expect(run).toMatchObject({ currentNodeId: "welcome", status: "WAITING_REPLY" });
    expect(effects).toEqual([
      expect.objectContaining({ type: "send_message", nodeId: "welcome", text: "Oi ana!" }),
      { type: "schedule_timer", nodeId: "welcome", delayMinutes: 30 },
    ]);
  });

  it("follows a reply button to the follow check and asks the executor to verify", () => {
    const { run } = started();
    const next = step(graph, run, { type: "button", nodeId: "welcome", buttonId: "yes" });
    expect(next.run.currentNodeId).toBe("follow");
    expect(next.effects).toEqual([{ type: "check_follow", nodeId: "follow" }]);
  });

  it("branches on the follow result and runs to the end", () => {
    const afterTap = step(graph, started().run, { type: "button", nodeId: "welcome", buttonId: "yes" });
    const follows = step(graph, afterTap.run, { type: "follow_result", nodeId: "follow", follows: true });
    expect(follows.effects.map((e) => e.type)).toEqual(["send_message", "complete"]);
    expect(follows.run.status).toBe("COMPLETED");

    const notFollows = step(graph, afterTap.run, { type: "follow_result", nodeId: "follow", follows: false });
    expect(notFollows.effects[0]).toMatchObject({ type: "send_message", nodeId: "ask" });
  });

  it("treats unverifiable follow status as following (fails open)", () => {
    const afterTap = step(graph, started().run, { type: "button", nodeId: "welcome", buttonId: "yes" });
    const result = step(graph, afterTap.run, { type: "follow_result", nodeId: "follow", follows: null });
    expect(result.effects[0]).toMatchObject({ nodeId: "link" });
  });

  it("sends the reminder when the no-interaction timer fires", () => {
    const result = step(graph, started().run, { type: "timeout", nodeId: "welcome" });
    expect(result.effects.map((e) => e.type)).toEqual(["send_message", "complete"]);
    expect(result.effects[0]).toMatchObject({ nodeId: "reminder" });
  });

  it("ignores a stale timer and a stale button once the run moved on", () => {
    const moved = step(graph, started().run, { type: "button", nodeId: "welcome", buttonId: "no" });
    expect(moved.run.status).toBe("COMPLETED");
    expect(step(graph, moved.run, { type: "timeout", nodeId: "welcome" }).ignored).toBe(true);

    const waiting = started().run;
    const tapped = step(graph, waiting, { type: "button", nodeId: "welcome", buttonId: "yes" });
    expect(step(graph, tapped.run, { type: "button", nodeId: "welcome", buttonId: "no" }).ignored).toBe(true);
    expect(step(graph, tapped.run, { type: "timeout", nodeId: "welcome" }).ignored).toBe(true);
  });

  it("ignores typed text while waiting on buttons and unknown buttons", () => {
    const { run } = started();
    expect(step(graph, run, { type: "reply", text: "oi" }).ignored).toBe(true);
    expect(step(graph, run, { type: "button", nodeId: "welcome", buttonId: "zzz" }).ignored).toBe(true);
  });

  it("fails instead of looping forever when a graph slipped past validation", () => {
    const looping: FunnelGraph = {
      nodes: [
        { id: "s", type: "start", position: pos, data: {} },
        { id: "a", type: "message", position: pos, data: { text: "a", buttons: [] } },
        { id: "b", type: "message", position: pos, data: { text: "b", buttons: [] } },
      ],
      edges: [
        { id: "1", source: "s", sourceHandle: "next", target: "a" },
        { id: "2", source: "a", sourceHandle: "next", target: "b" },
        { id: "3", source: "b", sourceHandle: "next", target: "a" },
      ],
    };
    const result = step(looping, initialRun(looping), { type: "start" });
    expect(result.run.status).toBe("FAILED");
    expect(result.effects.at(-1)).toMatchObject({ type: "fail" });
  });
});

describe("funnel engine: replies and variables", () => {
  const replyGraph: FunnelGraph = {
    nodes: [
      { id: "s", type: "start", position: pos, data: {} },
      {
        id: "ask",
        type: "await_reply",
        position: pos,
        data: {
          keywords: [{ id: "price", words: ["preço", "valor"] }],
          timeoutMinutes: 60,
        },
      },
      { id: "save", type: "set_variable", position: pos, data: { name: "resposta", source: "reply" } },
      {
        id: "cond",
        type: "variable_condition",
        position: pos,
        data: { name: "resposta", operator: "contains", value: "quero" },
      },
      { id: "hot", type: "message", position: pos, data: { text: "Perfeito, {resposta}", buttons: [] } },
      { id: "cold", type: "message", position: pos, data: { text: "Sem problema", buttons: [] } },
      { id: "wait", type: "wait", position: pos, data: { delayMinutes: 10 } },
      { id: "end", type: "end", position: pos, data: {} },
    ],
    edges: [
      { id: "1", source: "s", sourceHandle: "next", target: "ask" },
      { id: "2", source: "ask", sourceHandle: "keyword:price", target: "end" },
      { id: "3", source: "ask", sourceHandle: "other", target: "save" },
      { id: "4", source: "ask", sourceHandle: "timeout", target: "wait" },
      { id: "5", source: "save", sourceHandle: "next", target: "cond" },
      { id: "6", source: "cond", sourceHandle: "yes", target: "hot" },
      { id: "7", source: "cond", sourceHandle: "no", target: "cold" },
      { id: "8", source: "hot", sourceHandle: "next", target: "end" },
      { id: "9", source: "cold", sourceHandle: "next", target: "end" },
      { id: "10", source: "wait", sourceHandle: "next", target: "end" },
    ],
  };

  const waiting = () => step(replyGraph, initialRun(replyGraph), { type: "start" });

  it("waits for a reply with a deadline", () => {
    const { run, effects } = waiting();
    expect(run.status).toBe("WAITING_REPLY");
    expect(effects).toEqual([{ type: "schedule_timer", nodeId: "ask", delayMinutes: 60 }]);
  });

  it("routes a keyword reply to its handle, folding case and accents", () => {
    const result = step(replyGraph, waiting().run, { type: "reply", text: "Qual o PREÇO?" });
    expect(result.run.status).toBe("COMPLETED");
  });

  it("stores another reply in a variable and branches on it", () => {
    const result = step(replyGraph, waiting().run, { type: "reply", text: "Eu quero sim" });
    expect(result.run.variables.resposta).toBe("Eu quero sim");
    expect(result.effects[0]).toMatchObject({ type: "send_message", nodeId: "hot", text: "Perfeito, Eu quero sim" });

    const cold = step(replyGraph, waiting().run, { type: "reply", text: "talvez" });
    expect(cold.effects[0]).toMatchObject({ nodeId: "cold" });
  });

  it("parks on a wait block with a timer when the reply deadline passes", () => {
    const result = step(replyGraph, waiting().run, { type: "timeout", nodeId: "ask" });
    expect(result.run).toMatchObject({ currentNodeId: "wait", status: "WAITING_TIMER" });
    expect(result.effects).toEqual([{ type: "schedule_timer", nodeId: "wait", delayMinutes: 10 }]);

    const done = step(replyGraph, result.run, { type: "timeout", nodeId: "wait" });
    expect(done.run.status).toBe("COMPLETED");
  });
});
