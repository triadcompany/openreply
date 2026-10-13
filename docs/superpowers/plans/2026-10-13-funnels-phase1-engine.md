# Funis, fase 1: motor de execução

Spec: `docs/superpowers/specs/2026-10-13-funnels-design.md`. Esta fase não tem tela. Entrega o modelo de dados, a validação do grafo e o motor no worker, tudo testado, mais um script para criar um funil de teste à mão.

Princípio de desenho: o **interpretador é puro** (recebe grafo, estado da execução e um evento; devolve o novo estado e uma lista de efeitos). Quem faz I/O (Instagram, Redis, banco) é o **executor**. Assim quase toda a lógica é testável sem mock de rede.

## Tarefas

### 1. Esquema e validação do grafo (`lib/funnel/graph.ts`)
- Tipos Zod dos blocos: `start`, `message`, `await_reply`, `follow_check`, `wait`, `set_variable`, `variable_condition`, `end`. Cada bloco tem `id`, `type`, `position` (usado só pelo editor) e `data` específico.
- Ligações: `{ id, source, sourceHandle, target }`. `sourceHandle` nomeia a saída (`next`, `yes`, `no`, `timeout`, `button:<id>`, `keyword:<id>`, `other`).
- `validateGraph(graph)` devolve lista de erros com `nodeId`: sem `start`, bloco inalcançável, saída sem destino, ciclo sem bloco de espera, tempo >= 24 h, botão sem texto, mais de 2 botões.
- Testes: um grafo válido e um caso por erro.

### 2. Interpretador puro (`lib/funnel/engine.ts`)
- `step(graph, run, event)` onde `event` é `start`, `button` (id do botão), `reply` (texto), `timeout` (nodeId) ou `follow_result` (bool).
- Devolve `{ run, effects }`. Efeitos: `send_message`, `schedule_timer`, `cancel_timer`, `check_follow`, `complete`, `expire`, `fail`.
- Regras: teto de 25 passos sem interação, variáveis (`set_variable`, `variable_condition`), seleção de saída por palavra-chave (reusa `matchKeywords`), "outra resposta", timeout só age se `run.currentNodeId` ainda for o do evento.
- Testes: ramificações, botão de bloco antigo ignorado, timeout obsoleto ignorado, anti-loop, variáveis.

### 3. Modelo de dados e migração
- `prisma/schema.prisma`: `Funnel`, `FunnelVersion`, `FunnelRun` (enum `FunnelRunStatus`), `Automation.funnelId` com `onDelete: SetNull` e índice. `Workspace` ganha `funnels`.
- Migração escrita à mão em `prisma/migrations/20261013120000_funnels/migration.sql` (esta máquina não tem Postgres para gerar). Índice único em `FunnelRun(automationId, userId)` com `WHERE status IN ('ACTIVE','WAITING_REPLY','WAITING_TIMER')`.
- Conferir com `npx prisma validate` e `npx prisma generate`.

### 4. Persistência (`lib/funnel/runs.ts`)
- `startRun`, `loadActiveRun(automationId, userId)`, `advanceRun(runId, fromNodeId, patch)`. `advanceRun` usa `updateMany` com `where: { id, currentNodeId: fromNodeId }` e retorna se alguém ganhou a corrida; só quem ganha executa os efeitos.
- Teste com Prisma mockado (o repositório já usa vitest com mocks).

### 5. Executor (`lib/funnel/executor.ts`)
- Traduz efeitos em ações: `send_message` usa `sendPrivateReply*` no primeiro envio (comentário) e `sendDirectMessage*` depois; botão de link usa `TrackedLink`; botão de resposta usa payload `fn:<runId>:<nodeId>:<buttonId>`. Reserva o limite com `reserveDMSlot` e registra uma linha em `DmLog` por mensagem.
- `schedule_timer` usa `getDMQueue().add(FUNNEL_TIMER_JOB_NAME, ..., { delay, jobId: "fn_timer_<runId>_<nodeId>" })`.
- `check_follow` reusa `getUserFollowStatus` e a reconferência de `FOLLOW_RECHECK_DELAYS_MS`.
- Antes de cada envio confere `windowExpiresAt`; vencida vira `expire` com motivo no log.

### 6. Fila e despacho (`lib/queue/client.ts`, `lib/queue/dm-worker.ts`)
- Novos tipos `ProcessFunnelTimerJob` e constante `FUNNEL_TIMER_JOB_NAME`; `dispatchJob` encaminha para o executor.

### 7. Ganchos no worker (mudança mínima em `dm-worker.ts`)
- `processComment`: depois de casar a palavra-chave e passar pelas checagens de credencial e limite, se `automation.funnelId` e há versão publicada, inicia a execução e `continue` (o fluxo fixo é ignorado).
- `processPostback`: payload com prefixo `fn:` vai para o motor, antes do `return` dos prefixos antigos.
- `processMessage`: antes de procurar campanhas por palavra-chave, se a pessoa tem execução em `WAITING_REPLY`, a mensagem avança essa execução.
- Campanha sem `funnelId`: caminho idêntico ao atual. Conferir com os testes existentes (`npm test`).

### 8. Script de teste manual (`scripts/funnel-seed.ts`)
- Cria um `Funnel` com grafo de exemplo (mensagem com 2 botões, "Seguir?", link, e uma saída "sem interação após 30 min" com mensagem de lembrete), publica a versão 1 e liga à campanha informada por argumento.
- Rodar no console do EasyPanel: `npx tsx scripts/funnel-seed.ts <automationId>`.

### 9. Verificação e entrega
- `npm test`, `npx tsc --noEmit` (com `npx prisma generate` antes) e `npx eslint`.
- Commit por tarefa na `main` do fork, deploy do web e do worker no EasyPanel (o `migrate deploy` roda no início do web).
- Teste manual: ligar o funil de exemplo à campanha `teste`, comentar de outra conta, tocar nos botões, deixar um sem tocar por 30 min e conferir o lembrete e o `DmLog`.

## Riscos
- `dm-worker.ts` tem mais de 1.600 linhas; os três ganchos devem ser pequenos e cercados por testes existentes.
- Sem Postgres local, a migração só é validada de verdade no deploy. Mitigação: SQL simples, conferido com `prisma validate`, e aplicação primeiro no web (que roda `migrate deploy`) antes de reiniciar o worker.
- A reconferência de seguir já é assíncrona (jobs); o motor precisa tratá-la como evento `follow_result`, não como chamada síncrona.
