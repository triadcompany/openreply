import { matchKeywords } from "@/lib/utils/keyword-matcher";
import {
  isWaitingNode,
  type FunnelGraph,
  type FunnelNode,
  type MessageButton,
} from "./graph";

/**
 * Pure funnel interpreter. It never touches the network or the database:
 * given a graph, the state of one person's run and an event, it returns the
 * next state and the effects the executor must perform. That keeps every
 * branching rule testable without mocks.
 */

// A run that keeps moving without the person doing anything is capped, so a
// graph that slipped past validation cannot loop forever.
export const MAX_INSTANT_STEPS = 25;

export type RunStatus =
  | "ACTIVE"
  | "WAITING_REPLY"
  | "WAITING_TIMER"
  | "COMPLETED"
  | "EXPIRED"
  | "FAILED";

export interface RunState {
  currentNodeId: string;
  status: RunStatus;
  variables: Record<string, string>;
  /** Last text the person typed; the source for "save variable" blocks. */
  lastReply?: string;
}

export type FunnelEvent =
  | { type: "start" }
  | { type: "button"; nodeId: string; buttonId: string }
  | { type: "reply"; text: string }
  /** A timer fired: a "wait" block elapsed, or a "no interaction" deadline hit. */
  | { type: "timeout"; nodeId: string }
  | { type: "follow_result"; nodeId: string; follows: boolean | null };

export type FunnelEffect =
  | { type: "send_message"; nodeId: string; text: string; buttons: MessageButton[] }
  | { type: "schedule_timer"; nodeId: string; delayMinutes: number }
  | { type: "check_follow"; nodeId: string }
  | { type: "complete" }
  | { type: "fail"; reason: string };

export interface StepContext {
  username?: string;
}

export interface StepResult {
  run: RunState;
  effects: FunnelEffect[];
  /** True when the event did not apply to the run's current position. */
  ignored: boolean;
}

const TERMINAL: RunStatus[] = ["COMPLETED", "EXPIRED", "FAILED"];

export function initialRun(graph: FunnelGraph): RunState {
  const start = graph.nodes.find((node) => node.type === "start");
  if (!start) throw new Error("Funnel has no start node");
  return { currentNodeId: start.id, status: "ACTIVE", variables: {} };
}

function fill(text: string, run: RunState, context: StepContext): string {
  return text.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    if (name === "username") return context.username ?? placeholder;
    return run.variables[name] ?? placeholder;
  });
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function targetOf(graph: FunnelGraph, nodeId: string, handle: string): string | undefined {
  return graph.edges.find(
    (edge) => edge.source === nodeId && edge.sourceHandle === handle
  )?.target;
}

function ignoredResult(run: RunState): StepResult {
  return { run, effects: [], ignored: true };
}

/** The output handle an event selects at the run's current node, if any. */
function selectHandle(
  node: FunnelNode,
  run: RunState,
  event: FunnelEvent
): { handle: string; variables?: Record<string, string>; lastReply?: string } | null {
  switch (event.type) {
    case "start":
      return node.type === "start" ? { handle: "next" } : null;
    case "button": {
      if (node.type !== "message" || node.id !== event.nodeId) return null;
      const button = node.data.buttons.find(
        (candidate) => candidate.kind === "reply" && candidate.id === event.buttonId
      );
      return button ? { handle: `button:${button.id}` } : null;
    }
    case "reply": {
      if (node.type !== "await_reply") return null;
      for (const keyword of node.data.keywords) {
        if (matchKeywords(event.text, keyword.words, true).matched) {
          return { handle: `keyword:${keyword.id}`, lastReply: event.text };
        }
      }
      return { handle: "other", lastReply: event.text };
    }
    case "timeout": {
      if (node.id !== event.nodeId) return null;
      if (node.type === "wait") return { handle: "next" };
      if (
        (node.type === "message" || node.type === "await_reply") &&
        node.data.timeoutMinutes
      ) {
        return { handle: "timeout" };
      }
      return null;
    }
    case "follow_result": {
      if (node.type !== "follow_check" || node.id !== event.nodeId) return null;
      // Instagram not reporting follow status fails open, as the fixed
      // campaign flow does, so a real follower is never trapped.
      return { handle: event.follows === false ? "not_follows" : "follows" };
    }
  }
}

function evaluateCondition(
  node: Extract<FunnelNode, { type: "variable_condition" }>,
  run: RunState
): boolean {
  const current = run.variables[node.data.name];
  if (node.data.operator === "exists") return current !== undefined && current !== "";
  if (current === undefined) return false;
  const expected = normalized(node.data.value ?? "");
  return node.data.operator === "equals"
    ? normalized(current) === expected
    : normalized(current).includes(expected);
}

export function step(
  graph: FunnelGraph,
  previous: RunState,
  event: FunnelEvent,
  context: StepContext = {}
): StepResult {
  if (TERMINAL.includes(previous.status)) return ignoredResult(previous);

  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const current = nodes.get(previous.currentNodeId);
  if (!current) {
    return {
      run: { ...previous, status: "FAILED" },
      effects: [{ type: "fail", reason: "Bloco atual não existe no funil." }],
      ignored: false,
    };
  }

  const selected = selectHandle(current, previous, event);
  if (!selected) return ignoredResult(previous);

  let run: RunState = {
    ...previous,
    status: "ACTIVE",
    variables: { ...previous.variables },
    ...(selected.lastReply !== undefined ? { lastReply: selected.lastReply } : {}),
  };
  const effects: FunnelEffect[] = [];

  const fail = (reason: string): StepResult => ({
    run: { ...run, status: "FAILED" },
    effects: [...effects, { type: "fail", reason }],
    ignored: false,
  });

  let handle = selected.handle;
  let nodeId = current.id;

  for (let steps = 0; steps < MAX_INSTANT_STEPS; steps++) {
    const targetId = targetOf(graph, nodeId, handle);
    const target = targetId ? nodes.get(targetId) : undefined;
    if (!target) return fail(`A saída "${handle}" do bloco ${nodeId} não tem destino.`);

    run = { ...run, currentNodeId: target.id };
    nodeId = target.id;

    switch (target.type) {
      case "message": {
        effects.push({
          type: "send_message",
          nodeId: target.id,
          text: fill(target.data.text, run, context),
          buttons: target.data.buttons,
        });
        if (isWaitingNode(target)) {
          if (target.data.timeoutMinutes) {
            effects.push({
              type: "schedule_timer",
              nodeId: target.id,
              delayMinutes: target.data.timeoutMinutes,
            });
          }
          return { run: { ...run, status: "WAITING_REPLY" }, effects, ignored: false };
        }
        handle = "next";
        break;
      }
      case "await_reply": {
        if (target.data.timeoutMinutes) {
          effects.push({
            type: "schedule_timer",
            nodeId: target.id,
            delayMinutes: target.data.timeoutMinutes,
          });
        }
        return { run: { ...run, status: "WAITING_REPLY" }, effects, ignored: false };
      }
      case "wait": {
        effects.push({
          type: "schedule_timer",
          nodeId: target.id,
          delayMinutes: target.data.delayMinutes,
        });
        return { run: { ...run, status: "WAITING_TIMER" }, effects, ignored: false };
      }
      case "follow_check": {
        effects.push({ type: "check_follow", nodeId: target.id });
        return { run, effects, ignored: false };
      }
      case "set_variable": {
        const value =
          target.data.source === "reply" ? run.lastReply : target.data.value;
        if (value !== undefined) {
          run = {
            ...run,
            variables: { ...run.variables, [target.data.name]: value },
          };
        }
        handle = "next";
        break;
      }
      case "variable_condition": {
        handle = evaluateCondition(target, run) ? "yes" : "no";
        break;
      }
      case "end": {
        effects.push({ type: "complete" });
        return { run: { ...run, status: "COMPLETED" }, effects, ignored: false };
      }
      case "start": {
        return fail("O bloco Início não pode ser destino de uma ligação.");
      }
    }
  }

  return fail(`Mais de ${MAX_INSTANT_STEPS} passos sem interação da pessoa.`);
}
