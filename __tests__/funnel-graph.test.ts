import { describe, expect, it } from "vitest";
import { validateGraph, type FunnelGraph } from "../lib/funnel/graph";

const pos = { x: 0, y: 0 };

function graph(partial: Partial<FunnelGraph> = {}): FunnelGraph {
  return {
    nodes: [
      { id: "s", type: "start", position: pos, data: {} },
      {
        id: "m",
        type: "message",
        position: pos,
        data: {
          text: "Oi {username}",
          buttons: [{ id: "b1", kind: "reply", label: "Quero" }],
          timeoutMinutes: 30,
        },
      },
      { id: "e", type: "end", position: pos, data: {} },
      {
        id: "r",
        type: "message",
        position: pos,
        data: { text: "Lembrete", buttons: [] },
      },
    ],
    edges: [
      { id: "1", source: "s", sourceHandle: "next", target: "m" },
      { id: "2", source: "m", sourceHandle: "button:b1", target: "e" },
      { id: "3", source: "m", sourceHandle: "timeout", target: "r" },
      { id: "4", source: "r", sourceHandle: "next", target: "e" },
    ],
    ...partial,
  };
}

const codes = (input: unknown) => validateGraph(input).map((error) => error.code);

describe("funnel graph validation", () => {
  it("accepts a valid funnel", () => {
    expect(validateGraph(graph())).toEqual([]);
  });

  it("requires exactly one start block", () => {
    const g = graph();
    g.nodes = g.nodes.filter((node) => node.type !== "start");
    expect(codes(g)).toContain("start");
  });

  it("reports an output with no destination", () => {
    const g = graph();
    g.edges = g.edges.filter((edge) => edge.id !== "3");
    expect(validateGraph(g)).toContainEqual(
      expect.objectContaining({ nodeId: "m", code: "missing_target" })
    );
  });

  it("reports an unreachable block", () => {
    const g = graph();
    g.nodes.push({ id: "x", type: "end", position: pos, data: {} });
    expect(validateGraph(g)).toContainEqual(
      expect.objectContaining({ nodeId: "x", code: "unreachable" })
    );
  });

  it("rejects waits of 24 hours or more", () => {
    const g = graph();
    const m = g.nodes[1];
    if (m.type === "message") m.data.timeoutMinutes = 24 * 60;
    expect(codes(g)).toContain("invalid");
  });

  it("rejects more than two buttons", () => {
    const g = graph();
    const m = g.nodes[1];
    if (m.type === "message") {
      m.data.buttons = [1, 2, 3].map((n) => ({
        id: `b${n}`,
        kind: "reply" as const,
        label: `B${n}`,
      }));
    }
    expect(codes(g)).toContain("invalid");
  });

  it("rejects a no-interaction timeout without a reply button", () => {
    const g = graph();
    const m = g.nodes[1];
    if (m.type === "message") m.data.buttons = [];
    expect(codes(g)).toContain("timeout_without_reply");
  });

  it("rejects a loop with no waiting block but allows one that waits", () => {
    const loop = graph();
    loop.nodes = [
      { id: "s", type: "start", position: pos, data: {} },
      { id: "a", type: "message", position: pos, data: { text: "a", buttons: [] } },
      { id: "b", type: "message", position: pos, data: { text: "b", buttons: [] } },
    ];
    loop.edges = [
      { id: "1", source: "s", sourceHandle: "next", target: "a" },
      { id: "2", source: "a", sourceHandle: "next", target: "b" },
      { id: "3", source: "b", sourceHandle: "next", target: "a" },
    ];
    expect(codes(loop)).toContain("loop_without_wait");

    loop.nodes[2] = {
      id: "b",
      type: "wait",
      position: pos,
      data: { delayMinutes: 5 },
    };
    expect(codes(loop)).not.toContain("loop_without_wait");
  });
});
