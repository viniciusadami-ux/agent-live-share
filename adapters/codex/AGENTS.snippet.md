# Collab MCP — instruções para o projeto compartilhado (Codex)

> Este snippet é para o **projeto compartilhado** (workspace real), não para o repositório do servidor Collab MCP.

Este projeto é um workspace colaborativo controlado pelo **Collab MCP**. Todos os agentes trabalham no mesmo diretório real. Não crie clone, worktree, cópia paralela ou branch própria.

## Regras obrigatórias

- Use as tools do servidor MCP `collab` para leitura/escrita de arquivos compartilhados.
- Não use editor nativo, shell, `git checkout`, `cp`, `mv` ou scripts para **gravar** arquivos compartilhados. O modo é cooperativo; ferramentas nativas podem ignorar locks/hashes/checkpoints.
- O Bearer de transporte (`COLLAB_MCP_BEARER`) e o `sessionToken` da sala são secretos. Nunca os coloque em mensagens, arquivos, handoff, logs, issues ou commits. O `sessionToken` fica apenas em memória.
- Não presuma que outro agente será acordado ou notificado. Use `collab_get_updates` (polling não bloqueante).
- O app/sessão Codex precisa estar aberto e ativo, e o processo precisa alcançar a URL configurada. O Collab MCP não acorda o aplicativo.
- Se o Codex pedir aprovação para uma tool de escrita, leia o efeito antes de aprovar; não contorne a aprovação com ferramenta nativa.

## Início

1. `collab_status` — confirme principal, auth e protocolo.
2. `collab_list_workspaces` **sem `token`** — descubra os `workspaceId` autorizados. Lista vazia = sem acesso; pare e peça ao operador.
3. Coordinator: `collab_create_room` (`displayName`, `clientKind`, `roomName`, `workspaceId`). Guarde `sessionToken` somente em memória.
4. Participantes: `collab_join_room` com o convite recebido por canal privado.
5. `collab_room_state` para confirmar papéis/coordinator.

## Presença

- Sessão: TTL 15 min; `collab_heartbeat` a cada ~5 min.
- Lock: TTL 5 min; `collab_lock_renew` a cada ~2 min enquanto mantiver.
- `SESSION_INACTIVE`: pare; peça novo convite e entre novamente. Não há recuperação automática.

## Arquivos

Fluxo para arquivo existente:

1. `collab_read_file` → `hash`/`version`.
2. `collab_lock_acquire` → `lockId` (com `intent`, `taskId` quando houver).
3. `collab_read_file` novamente → use o hash atual.
4. `collab_apply_patch` com `lockId`, `expectedHash` e `replacements` exatas (`oldText`/`newText`).
5. `collab_lock_release`.
6. Mensagem/handoff.

Arquivo novo: `collab_create_file` com `lockId`; o diretório pai precisa existir. Restaurar: `collab_restore_version` com `version`, `lockId`, `expectedHash`. Não há delete/rename/move.

`LOCK_ALREADY_HELD`: não escreva; `collab_lock_status`, negocie via `collab_send_message`, trabalhe em outro arquivo, reacquire e **releia** depois da liberação. Nunca contorne o lock.

## Tarefas e handoff

- Coordinator: `collab_propose_task`/`collab_assign_task`.
- Agente atribuído: `collab_list_tasks`, depois `collab_update_task` com `accept`, `start`, `progress`, `block`, `unblock`, `complete` ou `cancel` conforme a permissão.
- `block` exige `note`. `complete` exige `collab_submit_handoff` suficiente do mesmo autor (objetivo real + pelo menos um teste).
- Handoff: arquivos declarados (metadados), testes, decisões, problemas, itens reutilizáveis, pendências e próximo passo. Libere locks explicitamente; os campos de locks do handoff ainda não são automáticos.
- `requestReview: true` abre revisão; autor não revisa o próprio handoff.

## Checkpoint

- Só coordinator atual inicia com zero locks ativos.
- Se `collab_checkpoint_status` mostrar `paused: true`, não aplique patch/crie/restaure arquivos; aguarde `collab_checkpoint_end`.
- Qualquer coordinator atual do mesmo workspace pode encerrar; não execute Git/build/shell como parte do checkpoint.

## Erros

- `FORBIDDEN`: pare; não tente outros IDs/tokens para descobrir acesso.
- `SESSION_INACTIVE`: pare; reingresse com novo convite.
- `LOCK_ALREADY_HELD`: negocie e trabalhe em outro arquivo.
- `HASH_MISMATCH`/`VERSION_MISMATCH`: releia e refaça o patch com o hash atual.
- `PATCH_NOT_APPLICABLE`: ajuste o `oldText` exato; não reescreva o arquivo inteiro.
- `CHECKPOINT_IN_PROGRESS`: aguarde o encerramento; não escreva.
- HTTP 401/403/429: corrija Bearer/autorização; respeite `Retry-After`. 403 = sessão MCP de outro principal; negativa de workspace aparece na tool como `FORBIDDEN`.

Protocolo completo: `adapters/shared/AGENT_PROTOCOL.md` no repositório do Collab MCP (ou material do operador). Em divergência, siga o `code`/`hint` do servidor.
