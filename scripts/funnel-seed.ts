/**
 * Creates and publishes an example funnel and links it to a campaign, so the
 * funnel engine can be tried before the editor exists.
 *
 *   npx tsx scripts/funnel-seed.ts <automationId> [linkUrl]
 *   npx tsx scripts/funnel-seed.ts <automationId> --unlink
 *
 * Example flow: ask "want the link?" -> if nobody taps within 30 minutes send a
 * reminder -> check they follow -> send the tracked link button, or ask them to
 * follow and tap again.
 */
import { prisma } from "@/lib/db/client";
import { validateGraph, type FunnelGraph } from "@/lib/funnel/graph";

const [automationId, option] = process.argv.slice(2);
if (!automationId) {
  console.error("Uso: npx tsx scripts/funnel-seed.ts <automationId> [linkUrl | --unlink]");
  process.exit(1);
}

const pos = { x: 0, y: 0 };

function exampleGraph(linkUrl: string): FunnelGraph {
  return {
    nodes: [
      { id: "start", type: "start", position: pos, data: {} },
      {
        id: "welcome",
        type: "message",
        position: pos,
        data: {
          text: "Oi {username}! Quer receber o link?",
          buttons: [{ id: "yes", kind: "reply", label: "Quero" }],
          timeoutMinutes: 30,
        },
      },
      {
        id: "reminder",
        type: "message",
        position: pos,
        data: {
          text: "Ainda quer o link? É só tocar no botão.",
          buttons: [{ id: "yes", kind: "reply", label: "Quero" }],
        },
      },
      { id: "follow", type: "follow_check", position: pos, data: {} },
      {
        id: "link",
        type: "message",
        position: pos,
        data: {
          text: "Aqui está, {username}!",
          buttons: [{ id: "open", kind: "link", label: "Abrir link", url: linkUrl }],
        },
      },
      {
        id: "askfollow",
        type: "message",
        position: pos,
        data: {
          text: "Antes, segue a gente por aqui. Depois toque no botão que eu envio.",
          buttons: [{ id: "done", kind: "reply", label: "Já segui" }],
        },
      },
      { id: "end", type: "end", position: pos, data: {} },
    ],
    edges: [
      { id: "e1", source: "start", sourceHandle: "next", target: "welcome" },
      { id: "e2", source: "welcome", sourceHandle: "button:yes", target: "follow" },
      { id: "e3", source: "welcome", sourceHandle: "timeout", target: "reminder" },
      { id: "e4", source: "reminder", sourceHandle: "button:yes", target: "follow" },
      { id: "e5", source: "follow", sourceHandle: "follows", target: "link" },
      { id: "e6", source: "follow", sourceHandle: "not_follows", target: "askfollow" },
      { id: "e7", source: "askfollow", sourceHandle: "button:done", target: "follow" },
      { id: "e8", source: "link", sourceHandle: "next", target: "end" },
    ],
  };
}

async function main() {
  const automation = await prisma.automation.findUnique({
    where: { id: automationId },
    select: { id: true, name: true, workspaceId: true },
  });
  if (!automation) throw new Error(`Campanha ${automationId} não encontrada.`);

  if (option === "--unlink") {
    await prisma.automation.update({ where: { id: automationId }, data: { funnelId: null } });
    console.log(`Campanha "${automation.name}" voltou ao fluxo fixo.`);
    return;
  }

  const graph = exampleGraph(option ?? "https://example.com");
  const errors = validateGraph(graph);
  if (errors.length > 0) throw new Error(`Funil inválido: ${JSON.stringify(errors)}`);

  const funnel = await prisma.$transaction(async (tx) => {
    const created = await tx.funnel.create({
      data: {
        workspaceId: automation.workspaceId,
        name: `Exemplo para ${automation.name}`,
        draft: graph,
        publishedVersion: 1,
      },
    });
    await tx.funnelVersion.create({ data: { funnelId: created.id, version: 1, graph } });
    await tx.automation.update({ where: { id: automationId }, data: { funnelId: created.id } });
    return created;
  });
  console.log(`Funil ${funnel.id} publicado (v1) e ligado à campanha "${automation.name}".`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
