import { z } from "zod";

// Instagram only lets an account message someone within 24 hours of that
// person's last interaction, so no wait inside a funnel may reach a full day.
export const MAX_DELAY_MINUTES = 24 * 60 - 1;
export const MAX_MESSAGE_BUTTONS = 2;

const position = z.object({ x: z.number(), y: z.number() });
const minutes = z.number().int().min(1).max(MAX_DELAY_MINUTES);
const handleId = z.string().min(1).max(40);

const linkButton = z.object({
  id: handleId,
  kind: z.literal("link"),
  label: z.string().min(1).max(20),
  url: z.url(),
});
const replyButton = z.object({
  id: handleId,
  kind: z.literal("reply"),
  label: z.string().min(1).max(20),
});
export const messageButtonSchema = z.discriminatedUnion("kind", [
  linkButton,
  replyButton,
]);

const variableName = z.string().regex(/^[a-z][a-z0-9_]{0,29}$/);

const node = <T extends string, D extends z.ZodType>(type: T, data: D) =>
  z.object({ id: z.string().min(1).max(40), type: z.literal(type), position, data });

export const funnelNodeSchema = z.discriminatedUnion("type", [
  node("start", z.object({})),
  node(
    "message",
    z.object({
      text: z.string().min(1).max(1000),
      buttons: z.array(messageButtonSchema).max(MAX_MESSAGE_BUTTONS).default([]),
      // "No interaction after N minutes" exit; only meaningful with reply buttons.
      timeoutMinutes: minutes.optional(),
    })
  ),
  node(
    "await_reply",
    z.object({
      keywords: z
        .array(
          z.object({
            id: handleId,
            words: z.array(z.string().min(1).max(60)).min(1).max(20),
          })
        )
        .max(8)
        .default([]),
      timeoutMinutes: minutes.optional(),
    })
  ),
  node("follow_check", z.object({})),
  node("wait", z.object({ delayMinutes: minutes })),
  node(
    "set_variable",
    z.object({
      name: variableName,
      source: z.enum(["reply", "fixed"]),
      value: z.string().max(200).optional(),
    })
  ),
  node(
    "variable_condition",
    z.object({
      name: variableName,
      operator: z.enum(["equals", "contains", "exists"]),
      value: z.string().max(200).optional(),
    })
  ),
  node("end", z.object({})),
]);

export const funnelEdgeSchema = z.object({
  id: z.string().min(1).max(60),
  source: z.string().min(1),
  sourceHandle: z.string().min(1),
  target: z.string().min(1),
});

export const funnelGraphSchema = z.object({
  nodes: z.array(funnelNodeSchema).min(1).max(100),
  edges: z.array(funnelEdgeSchema).max(300),
});

export type FunnelNode = z.infer<typeof funnelNodeSchema>;
export type FunnelEdge = z.infer<typeof funnelEdgeSchema>;
export type FunnelGraph = z.infer<typeof funnelGraphSchema>;
export type MessageButton = z.infer<typeof messageButtonSchema>;

type NodeOf<T extends FunnelNode["type"]> = Extract<FunnelNode, { type: T }>;

export function replyButtons(node: NodeOf<"message">) {
  return node.data.buttons.filter(
    (button): button is Extract<MessageButton, { kind: "reply" }> =>
      button.kind === "reply"
  );
}

/** Output handles a node must have connected, in display order. */
export function nodeHandles(node: FunnelNode): string[] {
  switch (node.type) {
    case "start":
    case "wait":
    case "set_variable":
      return ["next"];
    case "message": {
      const replies = replyButtons(node);
      if (replies.length === 0) return ["next"];
      return [
        ...replies.map((button) => `button:${button.id}`),
        ...(node.data.timeoutMinutes ? ["timeout"] : []),
      ];
    }
    case "await_reply":
      return [
        ...node.data.keywords.map((keyword) => `keyword:${keyword.id}`),
        "other",
        ...(node.data.timeoutMinutes ? ["timeout"] : []),
      ];
    case "follow_check":
      return ["follows", "not_follows"];
    case "variable_condition":
      return ["yes", "no"];
    case "end":
      return [];
  }
}

/** Whether the run parks at this node until something happens. */
export function isWaitingNode(node: FunnelNode): boolean {
  if (node.type === "wait" || node.type === "await_reply") return true;
  return node.type === "message" && replyButtons(node).length > 0;
}

export interface GraphError {
  nodeId?: string;
  code: string;
  message: string;
}

export function validateGraph(input: unknown): GraphError[] {
  const parsed = funnelGraphSchema.safeParse(input);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => {
      const index = issue.path[0] === "nodes" ? issue.path[1] : undefined;
      const nodeId =
        typeof index === "number" && Array.isArray((input as FunnelGraph)?.nodes)
          ? (input as FunnelGraph).nodes[index]?.id
          : undefined;
      return { nodeId, code: "invalid", message: issue.message };
    });
  }

  const graph = parsed.data;
  const errors: GraphError[] = [];
  const byId = new Map<string, FunnelNode>();
  for (const n of graph.nodes) {
    if (byId.has(n.id)) {
      errors.push({ nodeId: n.id, code: "duplicate_id", message: "Dois blocos com o mesmo id." });
    }
    byId.set(n.id, n);
  }

  const starts = graph.nodes.filter((n) => n.type === "start");
  if (starts.length !== 1) {
    errors.push({ code: "start", message: "O funil precisa de exatamente um bloco Início." });
  }

  const outgoing = new Map<string, Map<string, string>>();
  for (const edge of graph.edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) {
      errors.push({ code: "edge", message: "Ligação aponta para um bloco que não existe." });
      continue;
    }
    const handles = outgoing.get(edge.source) ?? new Map<string, string>();
    if (handles.has(edge.sourceHandle)) {
      errors.push({
        nodeId: edge.source,
        code: "duplicate_handle",
        message: "Uma saída está ligada a mais de um destino.",
      });
    }
    handles.set(edge.sourceHandle, edge.target);
    outgoing.set(edge.source, handles);
  }

  for (const n of graph.nodes) {
    const handles = outgoing.get(n.id);
    const expected = nodeHandles(n);
    for (const handle of expected) {
      if (!handles?.has(handle)) {
        errors.push({ nodeId: n.id, code: "missing_target", message: `A saída "${handle}" não tem destino.` });
      }
    }
    for (const handle of handles?.keys() ?? []) {
      if (!expected.includes(handle)) {
        errors.push({ nodeId: n.id, code: "unknown_handle", message: `A saída "${handle}" não existe neste bloco.` });
      }
    }

    if (n.type === "message") {
      const ids = n.data.buttons.map((button) => button.id);
      if (new Set(ids).size !== ids.length) {
        errors.push({ nodeId: n.id, code: "duplicate_button", message: "Dois botões com o mesmo id." });
      }
      if (n.data.timeoutMinutes && replyButtons(n).length === 0) {
        errors.push({
          nodeId: n.id,
          code: "timeout_without_reply",
          message: "\"Sem interação\" só funciona com ao menos um botão de resposta.",
        });
      }
    }
    if (n.type === "set_variable" && n.data.source === "fixed" && !n.data.value) {
      errors.push({ nodeId: n.id, code: "value", message: "Informe o valor da variável." });
    }
    if (
      n.type === "variable_condition" &&
      n.data.operator !== "exists" &&
      !n.data.value
    ) {
      errors.push({ nodeId: n.id, code: "value", message: "Informe o valor da condição." });
    }
  }

  if (starts.length === 1) {
    const seen = new Set<string>([starts[0].id]);
    const queue = [starts[0].id];
    while (queue.length) {
      for (const target of outgoing.get(queue.shift()!)?.values() ?? []) {
        if (!seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
    }
    for (const n of graph.nodes) {
      if (!seen.has(n.id)) {
        errors.push({ nodeId: n.id, code: "unreachable", message: "Bloco não alcançável a partir do Início." });
      }
    }
  }

  // A loop made only of blocks that never pause would spin forever. Any loop
  // that passes through a waiting block is fine: the 24 hour window ends it.
  const instant = graph.nodes.filter((n) => !isWaitingNode(n) && n.type !== "end");
  const instantIds = new Set(instant.map((n) => n.id));
  const state = new Map<string, 1 | 2>();
  const reportedLoop = new Set<string>();
  const visit = (id: string): void => {
    state.set(id, 1);
    for (const target of outgoing.get(id)?.values() ?? []) {
      if (!instantIds.has(target)) continue;
      if (state.get(target) === 1) {
        if (!reportedLoop.has(target)) {
          reportedLoop.add(target);
          errors.push({
            nodeId: target,
            code: "loop_without_wait",
            message: "Ciclo sem nenhum bloco de espera ou resposta.",
          });
        }
      } else if (!state.has(target)) {
        visit(target);
      }
    }
    state.set(id, 2);
  };
  for (const n of instant) if (!state.has(n.id)) visit(n.id);

  return errors;
}
