# Referência das tools do Collab MCP

Inventário real registrado pelo servidor: **1 diagnóstico + 20 colaboração + 8 workspace + 3 checkpoint + 5 locking = 37 tools**.

Quase todas as tools de colaboração/workspace/locking/checkpoint exigem `token` (token de sessão de sala, prefixo `collab_s_`) e são autenticadas a cada chamada. `collab_status` e `collab_list_workspaces` usam apenas o Bearer de transporte. O Bearer (`collab_p_`) é configurado no cliente e **não** é argumento de tool.

## Envelope e erros

Sucesso (tools que usam o envelope):

```json
{"ok": true, "tool": "<nome-da-tool>", "data": {}}
```

Erro:

```json
{"ok": false, "tool": "<nome-da-tool>", "error": {"code": "FORBIDDEN", "message": "...", "hint": "..."}}
```

`collab_status` é a exceção: retorna o relatório diretamente no `structuredContent`/texto, sem envelope `{ok,...}`.

Códigos de erro usados pelo núcleo: `FORBIDDEN`, `SESSION_INACTIVE`, `NOT_FOUND`, `VALIDATION_FAILED`, `INVALID_STATE`, `CONFLICT`, `LOCK_NOT_HELD`, `LOCK_ALREADY_HELD`, `LOCK_EXPIRED`, `VERSION_MISMATCH`, `HASH_MISMATCH`, `PATCH_NOT_APPLICABLE`, `PATH_OUTSIDE_WORKSPACE`, `CHECKPOINT_IN_PROGRESS`, `INTERNAL`.

## Diagnóstico

### `collab_status`

Sem argumentos. Usa somente o Bearer de transporte.

Retorna: `status`, `serverName`, `serverVersion`, `protocolVersion`, `transport`, `startedAt`, `uptimeMs`, `persistenceDriver`, `migrationVersion`, `appliedMigrations`, `activeTransportSessions`, `authEnabled`, `principalId`, `principalName`.

Não retorna tokens, hash, root do workspace ou caminho absoluto do SQLite.

## Colaboração (20 tools)

Todas exigem `token`, exceto `collab_create_room` e `collab_join_room`, que recebem credenciais de criação/ingresso.

| Tool | Campos de entrada | Retorno principal |
|---|---|---|
| `collab_create_room` | `displayName` (1–80), `clientKind?` (1–60), `roomName` (1–120), `workspaceId` (1–200, opaco) | `agent`, `room`, `participant` (coordinator+worker), `session`, `sessionToken`; o token aparece UMA vez |
| `collab_create_invite` | `token`, `reviewer?` (boolean), `expiresInMinutes?` (1–43200), `maxUses?` (1–100) | `invite` (id, roles, expiresAt, maxUses, uses, status) e `inviteToken`; aparece UMA vez |
| `collab_join_room` | `inviteToken`, `displayName`, `clientKind?` | `agent`, `room`, `participant` (worker; reviewer se o convite permitir), `session`, `inviteId`, `sessionToken` |
| `collab_heartbeat` | `token` | `session`, `renewedUntil`; renova a expiração atômica |
| `collab_leave` | `token` | `sessionId`, `status: "revoked"`, `revokedAt`; coordinator recebe `warning` |
| `collab_room_state` | `token` | `room`, `coordinator`, `self`, `participants[]`, `taskSummary` |
| `collab_transfer_coordinator` | `token`, `targetAgentId` | `room`, `previousCoordinatorAgentId`, `newCoordinator` |
| `collab_revoke_invite` | `token`, `inviteId` | `invite` com `status: "revoked"` (idempotente) |
| `collab_send_message` | `token`, `body` (1–8000), `toAgentId?`, `kind?: "chat"\|"decision"` | `message` com cursor |
| `collab_get_updates` | `token`, `cursor?` (dígitos), `limit?` (1–200; default 50) | `events[]`, `nextCursor`, `hasMore`; polling não bloqueante |
| `collab_request_plan` | `token`, `subject` (1–200), `details?` (≤8000) | `request`, `message`; destinatário é o coordinator atual |
| `collab_respond_to_request` | `token`, `requestId`, `body` (1–8000) | `request` respondida (`answered`) e `message` correlata |
| `collab_list_requests` | `token`, `status?: "open"\|"answered"\|"closed"`, `limit?` | `requests[]`; coordinator vê todas, demais só as suas |
| `collab_propose_task` | `token`, `title` (1–200), `description?` (≤8000), `assigneeAgentId?`, `dependsOn?` (≤20 taskIds) | `task` em `proposed` |
| `collab_assign_task` | `token`, `taskId`, `assigneeAgentId` | `task`; reatribuição volta para `proposed` |
| `collab_update_task` | `token`, `taskId`, `action: "accept"\|"start"\|"block"\|"unblock"\|"progress"\|"complete"\|"cancel"`, `note?` (≤4000), `reason?` (≤2000) | `task`, e `message` (block/progress) ou `handoff` (complete) quando aplicável |
| `collab_list_tasks` | `token`, `status?`, `assigneeAgentId?`, `limit?` | `tasks[]` com status, responsável, `dependsOn`, `handoffCount`, `latestHandoffId` |
| `collab_submit_handoff` | `token`, `taskId`, `objective` (1–4000), `changes?` (≤100 metadados `{path,kind}`), `tests?` (≤100 `{name,passed}`), `decisions?`, `knownIssues?`, `reusable?`, `pending?`, `nextStep?`, `requestReview?` | `handoff` persistente e evento de sala |
| `collab_review_handoff` | `token`, `handoffId`, `decision: "approved"\|"changes_requested"`, `notes?` (≤4000; obrigatório em changes_requested) | `handoff` revisado; autor não revisa o próprio |
| `collab_list_handoffs` | `token`, `taskId?`, `limit?` | `handoffs[]` |

Observações de autorização:

- `collab_create_room` e `collab_create_invite` exigem que o principal conste em `allowedPrincipals` do workspace; convite não amplia essa autorização.
- `collab_create_room` não aceita root/caminho; `workspaceId` é opaco.
- `collab_join_room` também revalida a autorização do principal antes de criar agente/sessão e antes de consumir o convite.
- `collab_request_plan` é para um participante que não é o coordinator atual; o coordinator usa `collab_propose_task`.
- `collab_transfer_coordinator` exige coordinator atual e participante ativo de destino.
- Só o coordinator atual transfere coordenação, cria/revoga convites, propõe/atribui/cancela tarefas.
- Só o agente atribuído executa accept/start/block/unblock/progress/complete.
- `complete` exige handoff suficiente (objetivo ≥10 caracteres e ao menos um teste) do mesmo agente.

## Workspace (8 tools)

A maioria exige `token`; a autorização por workspace (`allowedPrincipals`) é revalidada a cada chamada. Caminhos são relativos ao workspace, normalizados pelo servidor. `collab_list_workspaces` é a exceção e pode ser usado só com Bearer antes da primeira sala.

| Tool | Campos de entrada | Retorno principal |
|---|---|---|
| `collab_list_workspaces` | `token?` (opcional; só Bearer já basta) | `workspaces[]` apenas com `id`/`name` autorizados ao principal |
| `collab_list_files` | `token`, `path?`, `offset?` (≥0), `limit?` (1–500; default 100), `depth?` (0–32; limitado ao máximo configurado) | `entries[]` (`path`, `isDirectory`, `sizeBytes`), `offset`, `limit`, `total`, `hasMore` |
| `collab_read_file` | `token`, `path` | `path`, `hash` SHA-256, `version`, `tracked`, `sizeBytes`, `encoding: "utf-8"`, `content`, `notice?` |
| `collab_search_files` | `token`, `query` (1–500), `mode?: "name"\|"content"\|"both"`, `path?`, `limit?` (1–100) | `matches[]` (`path`, `kind`, `line?`, `snippet?`), `filesScanned`, `truncated` |
| `collab_apply_patch` | `token`, `path`, `lockId`, `expectedHash` (64 hex), `replacements[1..50]` `{oldText,newText,expectedOccurrences?}`, `note?` (≤2000) | `path`, `hash` novo, `version`, `previousHash`, `previousVersion`, `replacementsApplied`, `notice` |
| `collab_create_file` | `token`, `path`, `lockId`, `content` (≤2.000.000), `note?` | `path`, `hash`, `version`, `previousHash`, `previousVersion`, `notice` |
| `collab_file_history` | `token`, `path`, `limit?` (1–100) | `path`, `versions[]` (número, hash, tamanho, tipo, autor, data; sem conteúdo) |
| `collab_restore_version` | `token`, `path`, `lockId`, `expectedHash`, `version` (≥1), `note?` | `path`, `hash`, `version`, `previousHash`, `previousVersion`, `restoredFromVersion`, `notice` |

Regras:

- `collab_read_file` não exige lock; leitura não é auditada.
- `collab_apply_patch`/`collab_create_file`/`collab_restore_version` exigem lock válido da mesma sessão/agente/arquivo/caminho, `expectedHash` atual e ausência de checkpoint aberto.
- `collab_create_file` não cria diretórios; o pai precisa existir.
- Não há delete/rename/move.
- `collab_list_files` ignora `.git`, `node_modules`, `.collab-mcp`, `data` e bancos/temporários internos; não segue symlinks/junctions.
- `collab_read_file` rejeita binários e arquivos acima do limite configurado (default 1 MB).
- Nenhuma resposta contém `rootPath` ou caminho absoluto do host.

## Checkpoint (3 tools)

| Tool | Campos | Retorno |
|---|---|---|
| `collab_checkpoint_begin` | `token`, `note?` (≤4000), `testResults?` (objeto JSON) | `checkpoint` aberto; exige coordinator atual e zero locks ativos no workspace |
| `collab_checkpoint_end` | `token`, `note?`, `testResults?` | `checkpoint` encerrado; qualquer coordinator atual do mesmo workspace pode encerrar |
| `collab_checkpoint_status` | `token` | `paused`, `checkpoint?`, `activeLocks` |

Enquanto `paused: true`, mutações de arquivo (`apply_patch`, `create_file`, `restore_version`) retornam `CHECKPOINT_IN_PROGRESS`. Locks podem ser renovados/liberados, mas não há escrita de arquivo.

## Locking (5 tools)

| Tool | Campos | Retorno |
|---|---|---|
| `collab_lock_acquire` | `token`, `path`, `intent` (1–500), `taskId?` | `lock`, `reacquired`; conflito = `LOCK_ALREADY_HELD` com dono/intenção/expiração |
| `collab_lock_renew` | `token`, `lockId` | `lock` renovado; somente o dono (mesma sessão/agente) |
| `collab_lock_release` | `token`, `lockId` | `lock` liberado; idempotente se já liberado |
| `collab_lock_status` | `token`, `path` | `path`, `held` (lock ativo ou `null`), `ownedByCaller` |
| `collab_lock_list` | `token` | `locks[]` ativos no workspace, inclusive de outras salas |

TTL padrão do lock: 5 minutos. Renovação/heartbeat é explícita; não há heartbeat automático na autenticação. O lock é global por workspace; coordinator não rouba lock.

## Ordem recomendada

1. `collab_status` (Bearer)
2. `collab_list_workspaces` sem `token` para descobrir os `workspaceId` autorizados
3. `collab_create_room` ou `collab_join_room`
4. `collab_room_state`
5. `collab_get_updates` (cursor 0) e heartbeat periódico
6. Planejamento/mensagens/tarefas
7. Para arquivos: `collab_read_file` → `collab_lock_acquire` → `collab_read_file` → `collab_apply_patch`/`collab_create_file` → `collab_lock_release`
8. `collab_submit_handoff` → `collab_update_task` (`complete`)
9. `collab_lock_release` de tudo e `collab_leave` (ou heartbeat se continuar)
