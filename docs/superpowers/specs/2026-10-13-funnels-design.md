# Funis em blocos (flow) ligados a campanhas

Data: 2026-10-13. Status: aprovado em conversa, aguardando revisão do documento.

## Objetivo

Hoje cada campanha (`Automation`) tem um fluxo fixo: comentário, resposta pública, DM de abertura, trava de seguir, DM com link e follow-up. Isso cabe numa única linha da tabela e o worker (`lib/queue/dm-worker.ts`) executa nessa ordem.

Queremos um **funil** livre, montado em blocos num editor de fluxo, que pode ser ligado a uma campanha. A campanha continua decidindo **quando** disparar (post, palavra-chave, DM, Story). Com funil ligado, o funil decide **o que acontece** depois do gatilho. Campanha sem funil roda exatamente como hoje.

## Restrição da Meta

Depois do primeiro DM por comentário, só dá para enviar a próxima mensagem se a pessoa interagir (toque em botão ou resposta), dentro de 24 horas da última interação. Um funil, portanto, nunca é uma sequência de mensagens soltas: entre etapas a pessoa precisa interagir. Esperas e follow-ups por inatividade só valem dentro dessa janela.

## Escopo e fases

Três fases, cada uma funcionando e publicável antes da próxima:

1. **Motor de execução** (modelo de dados, worker, testes). Sem tela.
2. **Editor visual** em blocos (React Flow).
3. **Ligação com a campanha e métricas por bloco.**

Fora de escopo: gatilho próprio do funil independente de campanha, envio de mídia (imagem, vídeo), segmentação por tags entre campanhas.

## Modelo de dados (Prisma)

- `Funnel`: `id`, `workspaceId`, `name`, `draft` (Json: blocos, ligações, viewport), `publishedVersion` (Int, nulo se nunca publicado), timestamps.
- `FunnelVersion`: `funnelId`, `version`, `graph` (Json, imutável). Uma cópia por publicação. Quem já está no meio do funil continua na versão em que entrou.
- `FunnelRun`: `id`, `funnelId`, `version`, `automationId`, `instagramAccountId`, `userId` (ID da pessoa no Instagram), `username`, `currentNodeId`, `status` (`ACTIVE`, `WAITING_REPLY`, `WAITING_TIMER`, `COMPLETED`, `EXPIRED`, `FAILED`), `variables` (Json), `lastInteractionAt`, `windowExpiresAt`, timestamps. Uma execução ativa por pessoa e campanha (índice único parcial ou checagem transacional).
- `Automation.funnelId` opcional, com `onDelete: SetNull`. Várias campanhas podem usar o mesmo funil.

O fluxo fica em JSON (não em tabelas de blocos e ligações): salvar é uma operação única e o formato é o do React Flow. A validação roda ao publicar, com Zod, e o motor só executa grafos validados.

Métricas por bloco (tabela de eventos) ficam para a fase 3.

## Blocos da v1

- **Início:** fixo, representa o gatilho da campanha.
- **Mensagem:** texto com `{username}` e até 2 botões. Cada botão é de link rastreado (reaproveita `TrackedLink`, cliques e CTR) ou de resposta (cada botão de resposta é uma saída). Saída opcional "Sem interação após [tempo]", com tempo editável no bloco; é onde fica o follow-up por inatividade.
- **Aguardar resposta:** espera texto digitado. Saídas por palavra-chave, uma saída "outra resposta" e tempo-limite editável com saída "sem resposta".
- **Seguir?:** condição com saídas "segue" e "não segue", reaproveitando `getUserFollowStatus` e a reconferência de `FOLLOW_RECHECK_DELAYS_MS` (20 s e 40 s por padrão).
- **Esperar:** pausa pura em minutos ou horas, uma saída.
- **Salvar variável:** guarda um valor fixo ou a última resposta digitada em uma variável nomeada.
- **Condição por variável:** compara com "igual a", "contém" ou "existe"; saídas "sim" e "não".
- **Fim.**

Todo tempo configurável é limitado a menos de 24 h, descontado o que já transcorreu na janela.

## Execução (fase 1)

Arquitetura escolhida: módulo novo `lib/funnel/`, plugado no worker existente em três pontos. O caminho de campanha sem funil não muda.

Ganchos:
1. **Gatilho:** quando a campanha que casou tem `funnelId` e versão publicada, o worker inicia um `FunnelRun` no bloco seguinte ao Início, em vez de seguir o fluxo fixo.
2. **Toque de botão:** payload com prefixo `fn:<runId>:<nodeId>:<botão>`. É validado contra o bloco atual da execução; toque de bloco antigo é ignorado.
3. **Resposta de DM:** mensagem de quem tem execução em `WAITING_REPLY` avança essa execução.

Regras:
- Blocos que enviam usam o caminho de envio atual: limite de 750 por hora, tratamento de erros da Meta e **uma linha em `DmLog` por mensagem**.
- Blocos que esperam deixam a execução parada e agendam um job com atraso no BullMQ (como o follow-up atual), com `jobId` determinístico por execução e bloco. Ao disparar, o job só age se a pessoa ainda estiver naquele bloco; caso contrário é ignorado.
- Antes de cada envio, confere `windowExpiresAt`. Janela vencida marca a execução como `EXPIRED` e registra o motivo no log.
- Anti-loop: a publicação recusa ciclos sem bloco de espera; em execução há um teto de 25 passos sem interação da pessoa, passado o qual a execução vira `FAILED`.
- Concorrência: avanço de uma execução é transacional (troca de `currentNodeId` com checagem do valor anterior), para toque duplo ou job atrasado não enviarem duas vezes.

## Editor (fase 2)

- Entrada **Funis** no menu lateral, com lista e **Novo funil**.
- Tela com React Flow (`@xyflow/react`): paleta de blocos à esquerda, tela de arrastar e ligar ao centro, painel de configuração do bloco à direita. Cada saída é uma alça ligada ao próximo bloco.
- Rascunho salvo automaticamente. **Publicar** valida (blocos soltos, ciclos sem espera, tempos acima de 24 h, botão sem destino) e cria uma versão; os erros apontam o bloco.
- Textos em português do Brasil, seguindo o catálogo `lib/i18n/pt-BR.json`.

## Ligação e métricas (fase 3)

- Editor da campanha ganha seletor opcional **Funil**. Com funil escolhido, os campos de DM, trava de seguir e follow-up da campanha ficam desabilitados com aviso.
- Lista de campanhas mostra um selo com o funil ligado.
- Cada bloco mostra quantas pessoas passaram e onde pararam (tabela de eventos). Cliques e CTR por link continuam como hoje.

## Testes

- Fase 1: testes unitários do motor (vitest): ramificações, esperas, toque antigo ignorado, janela de 24 h vencida, anti-loop, execução única por pessoa e avanço duplicado.
- Teste manual ao fim de cada fase, com a conta `@thiago_.lisboa` e uma segunda conta testadora (o app da Meta está em acesso padrão).

## Entrega

Cada fase vai para a `main` do fork e é implantada no EasyPanel, web e worker (o motor roda no worker). O cron não muda. As migrações rodam no `prisma migrate deploy` do início. Campanhas sem funil permanecem idênticas em todas as fases.
