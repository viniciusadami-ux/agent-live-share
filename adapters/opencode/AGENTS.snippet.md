# Collab MCP — instruções para o projeto compartilhado

> Este snippet é para o **projeto compartilhado** (o workspace real em que os agentes trabalham), não para o repositório do servidor Collab MCP.

Este projeto é um workspace colaborativo controlado pelo **Collab MCP**. Todos os agentes trabalham no mesmo diretório real. Não crie clone, worktree, cópia paralela ou branch própria para isolar seu trabalho.

## Regras obrigatórias

- Use as ferramentas MCP do servidor `collab` para qualquer leitura/escrita de arquivo compartilhado.
- Não use editor nativo, shell, `git checkout`, `cp`, `mv` ou scripts para **gravar** arquivos compartilhados. O modo é cooperativo; ferramentas nativas podem ignorar locks, hashes e checkpoints.
- O Bearer de transporte e o `sessionToken` da sala são secretos. Nunca os coloque em mensagens, arquivos, handoff, logs, issues ou commits. O `sessionToken` fica somente em memória.
- Não presuma que outro agente será acordado ou notificado. O MCP não inicia aplicativos; use `collab_get_updates` (polling não bloqueante).

## Início

1. Chame `collab_status` para confirmar o principal autenticado e a conexão.
2. Chame `collab_list_workspaces` **sem `token`** para descobrir os `workspaceId` autorizados ao seu principal. Lista vazia = sem acesso; pare e peça ao operador.
3. Coordinator: `collab_create_room` com `displayName`, `clientKind`, `roomName` e um `workspaceId` autorizado. Guarde o `sessionToken` somente em memória.
4. Demais agentes: recebem um convite por canal privado e usam `collab_join_room`.
5. Confirme papéis/coordinator com `collab_room_state`.

## Presença

- Sessão de sala: TTL de 15 min. Chame `collab_heartbeat` a cada ~5 min.
- Lock: TTL de 5 min. Chame `collab_lock_renew` a cada ~2 min enquanto mantiver o lock.
- Se receber `SESSION_INACTIVE`, pare; peça novo convite e entre novamente. Não há recuperação automática.

## Arquivos

Fluxo obrigatório para arquivo existente:

1. `collab_read_file` — obtenha `hash` e `version`.
2. `collab_lock_acquire` — `path`, `intent` e `taskId` quando houver tarefa.
3. `collab_read_file` **novamente** — use o hash atual, não o da primeira leitura.
4. `collab_apply_patch` — `lockId`, `expectedHash` e `replacements` exatas (`oldText`/`newText`); não reescreva o arquivo inteiro.
5. `collab_lock_release` — libere o lock ao terminar.
6. Publique progresso/mensagem e envie o handoff.

Arquivo novo: `collab_create_file` com `lockId`; o diretório pai precisa existir. Restaurar: `collab_restore_version` com `version`, `lockId` e `expectedHash`. Não há delete/rename/move.

Em conflito `LOCK_ALREADY_HELD`: não escreva; consulte `collab_lock_status`, negocie com o dono via `collab_send_message` e trabalhe em outro arquivo. Nunca contorne o lock.

## Tarefas

- Coordinator: `collab_propose_task` / `collab_assign_task`.
- Agente atribuído: `collab_list_tasks`, depois `collab_update_task` com `accept`, `start`, `progress`, `block`, `unblock`, `complete` ou `cancel` conforme a permissão.
- Bloqueio exige `note`. Conclusão exige `collab_submit_handoff` suficiente do mesmo autor: objetivo real e pelo menos um teste.
- Handoff inclui arquivos declarados (metadados), testes, decisões, problemas, itens reutilizáveis, pendências e próximo passo. Libere os locks explicitamente; os campos de locks do handoff ainda não são automáticos.
- `requestReview: true` permite revisão por reviewer/coordinator; autor não revisa o próprio handoff.

## Checkpoint

- Só coordinator atual inicia com `collab_checkpoint_begin`; o workspace precisa ter zero locks ativos.
- Durante checkpoint (`collab_checkpoint_status` → `paused: true`), não aplique patch/crie/restaure arquivos. Aguarde `collab_checkpoint_end`.
- Qualquer coordinator atual do mesmo workspace pode encerrar; não execute Git/build/shell como parte do checkpoint.

## Erros

- `FORBIDDEN`: pare; não tente outros IDs/tokens para descobrir acesso.
- `SESSION_INACTIVE`: pare; reingresse com novo convite.
- `LOCK_ALREADY_HELD`: negocie e trabalhe em outro arquivo.
- `HASH_MISMATCH`/`VERSION_MISMATCH`: releia o arquivo e refaça o patch com o hash atual.
- `PATCH_NOT_APPLICABLE`: ajuste o `oldText` exato; não reescreva o arquivo inteiro.
- `CHECKPOINT_IN_PROGRESS`: aguarde o encerramento; não escreva.
- HTTP 401: Bearer ausente/inválido/revogado. HTTP 403: sessão MCP de outro principal. HTTP 429: respeite `Retry-After`.
- `FORBIDDEN` na tool (HTTP 200, `isError`): workspace/papel/coordinator sem permissão. Leia `error.hint`; não contorne.

O protocolo completo está em `adapters/shared/AGENT_PROTOCOL.md` no repositório do Collab MCP (ou no material fornecido pelo operador). Se houver divergência, siga o `code`/`hint` retornado pelo servidor.
