# Protocolo operacional do Collab MCP para agentes

Este documento é o contrato operacional mínimo para **qualquer agente** que entre em um workspace compartilhado pelo Collab MCP, independentemente do cliente (OpenCode, Codex, Claude Code ou outro cliente MCP).

O servidor é a autoridade. Este texto não substitui as respostas das ferramentas: quando houver divergência, siga o `code`, a `message` e o `hint` retornados pelo MCP. Alguns clientes podem exibir os nomes das tools com um prefixo do servidor; o nome lógico/real é o documentado em `TOOL_REFERENCE.md` e deve ser localizado na lista de tools do servidor `collab`.

> **Modo atual: cooperativo.** O MCP protege apenas as operações que passam por ele. Ferramentas nativas de edição e shell podem ignorar locks, hashes e checkpoints. O agente **deve** abster-se de usá-las para alterar arquivos compartilhados.

## 1. Regra de ouro

1. Trabalhe no **mesmo workspace real** configurado no servidor. Não crie clone, worktree, cópia paralela ou branch própria para “isolar” seu trabalho.
2. Toda alteração colaborativa de arquivo deve passar pelas ferramentas `collab_*` de workspace/locking.
3. Leia antes de escrever. Adquira o lock antes de alterar. Releia **depois** do lock. Use o hash atual em `expectedHash`.
4. Em conflito, negocie e trabalhe em outro arquivo. Nunca contorne, ignore ou “force” um lock.
5. Nunca coloque credenciais ou tokens em mensagens, arquivos, handoff, logs, issues, commits ou configuração versionada.
6. Não presuma que outro aplicativo será acordado, notificado ou continuará ativo. O Collab MCP não inicia sessões de agentes.

## 2. Dois segredos diferentes

| Segredo | Para que serve | Onde fica |
|---|---|---|
| **Bearer de transporte** (prefixo `collab_p_`) | Autentica o principal no endpoint HTTP `/mcp`. | Configuração do cliente, via variável de ambiente. Nunca é argumento de tool. |
| **Token de sessão de sala** (prefixo `collab_s_`) | Identifica o ator dentro de uma sala; é o campo `token` das tools de colaboração/workspace/locking. | Retornado uma única vez por `collab_create_room` ou `collab_join_room`; mantenha somente em memória. |
| **Token de convite** (prefixo `collab_i_`) | Permite que outro principal entre na sala. | Retornado uma única vez por `collab_create_invite`; entregue por canal privado fora do MCP. |

Regras:

- O Bearer de transporte é **por principal** (pessoa/cliente/instalação). Não compartilhe o seu.
- A sessão de sala é **vinculada ao principal** que a criou/ingressou. Um `sessionToken` vazado não funciona com o Bearer de outro principal; ainda assim, trate-o como segredo.
- Não grave `sessionToken` em arquivo do workspace, `AGENTS.md`, `.env`, issues, mensagens ou handoff. Se o processo cair, não há recuperação automática: entre novamente com um novo convite.
- Um convite não amplia `allowedPrincipals`. O principal que entra também precisa constar na lista do workspace no servidor.

## 3. Ordem inicial

### 3.1 Sempre comece pelo diagnóstico

Chame `collab_status` (sem argumentos). Ele usa somente o Bearer de transporte.

Verifique:

- `status: "ok"`;
- `authEnabled: true`;
- `principalId`/`principalName` (o principal correto);
- `protocolVersion` (baseline atual: `2025-11-25`);
- `transport: "streamable-http"`.

Se o cliente receber HTTP 401, o Bearer está ausente, inválido ou revogado. Não tente adivinhar tokens.

### 3.2 Descoberta de workspace

`collab_list_workspaces` **pode ser chamado antes de existir uma sessão de sala**. Só o Bearer de transporte é necessário; o `token` de sessão é opcional e, quando enviado, também é validado. Ele retorna somente `id`/`name` dos workspaces autorizados ao principal, nunca roots ou a lista completa.

- **Qualquer principal:** chame `collab_list_workspaces` sem `token` para descobrir os `workspaceId` autorizados. Se a lista vier vazia, pare e peça ao operador para incluir seu `prin_...` em `allowedPrincipals`; não tente adivinhar IDs.
- **Coordenador:** use um `workspaceId` retornado na lista em `collab_create_room`. Nunca peça root/caminho do host: o servidor não aceita caminho.
- **Participante que já tem sessão:** também pode chamar com `token` para confirmar o escopo; o resultado continua sendo o do principal autenticado.
- **Depois de criar/entrar na sala:** chame `collab_room_state` para confirmar sala, papéis e coordinator.

Não há tool de descoberta que retorne lista de principals ou roots.

### 3.3 Entre na sala

- **Coordenador:** `collab_create_room` com `displayName`, `clientKind`, `roomName` e `workspaceId`. O criador vira `coordinator + worker`.
- **Demais agentes:** recebem um convite por canal privado e chamam `collab_join_room` com `inviteToken`, `displayName` e `clientKind`. O ingresso normal é `worker`; `reviewer` é opcional conforme o convite. Convite nunca concede coordinator.

Guarde o `sessionToken` retornado **somente em memória**. Confirme com `collab_room_state`.

## 4. Presença e heartbeat

O servidor **não renova heartbeat automaticamente**.

- Sessão de sala: TTL padrão de **15 minutos**. Chame `collab_heartbeat` com o `token` a cada ~5 minutos enquanto estiver ativo, e antes de uma pausa previsível.
- Lock: TTL padrão de **5 minutos**. Chame `collab_lock_renew` com `lockId` a cada ~2 minutos enquanto mantiver o lock.
- Se você receber `SESSION_INACTIVE` (expirada/revogada), pare. Peça um novo convite e entre novamente. Não presuma reconexão automática nem “ressurreição” da sessão.
- `collab_leave` revoga a sessão de sala. Se você for o coordinator, transfira a coordenação antes de sair; a sala não faz failover automático.

## 5. Atualizações e mensagens

`collab_get_updates` é **polling não bloqueante**, por cursor monotônico:

```json
{"token": "<SESSION_TOKEN>", "cursor": "0", "limit": 50}
```

Retorna `events`, `nextCursor` e `hasMore` no `data`. Use o `nextCursor` na próxima chamada; se `hasMore` for `true`, continue até esgotar. Guarde o cursor em memória (ele não é um segredo, mas não é necessário persisti-lo no workspace).

Consulte:

- ao entrar na sala;
- antes e depois de aceitar/concluir uma tarefa;
- em marcos (lock adquirido, patch aplicado, bloqueio, handoff);
- periodicamente enquanto estiver ativo.

O MCP **não** envia push e **não** acorda aplicativos fechados. Outro agente só verá sua mensagem quando estiver ativo e consultar as atualizações.

Mensagens:

- `collab_send_message` sem `toAgentId` = mensagem da sala (broadcast).
- Com `toAgentId` = mensagem direta; somente remetente e destinatário a veem em `collab_get_updates`.
- Use `kind: "decision"` para decisões compartilhadas.
- Não há mensagem entre salas diferentes. O lock é global no workspace; conflito entre salas é visível, mas a negociação depende de canal externo.

## 6. Planejamento

1. Worker: `collab_request_plan` com `subject` e `details` opcional. O destinatário é derivado da sala, não informado pelo chamador.
2. Coordinator: `collab_respond_to_request` com `requestId` e `body`. A resposta é correlacionada à solicitação.
3. Qualquer participante envolvido (ou coordinator) pode consultar com `collab_list_requests`.

O coordinator propõe tarefas com `collab_propose_task` e pode atribuir/reatribuir com `collab_assign_task`.

## 7. Tarefas e handoff

Fluxo mínimo:

1. Coordinator propõe a tarefa e atribui a um participante ativo.
2. O agente atribuído localiza a tarefa com `collab_list_tasks` e chama `collab_update_task` com `action: "accept"`.
3. Antes de trabalhar, `action: "start"`. Dependências precisam estar `completed`.
4. Durante o trabalho: `action: "progress"` com `note`, ou `action: "block"` com `note` (obrigatória) quando houver bloqueio. Use `action: "unblock"` para retomar.
5. Para concluir, envie primeiro `collab_submit_handoff` e só depois use `action: "complete"`.

Regras:

- Só o agente atribuído executa accept/start/block/unblock/progress/complete. Coordinator não executa a tarefa alheia.
- `cancel` é do coordinator.
- `complete` exige handoff suficiente do **mesmo autor**: objetivo real (pelo menos 10 caracteres) e pelo menos um resultado em `tests[]`. Um handoff com `objective: "done"` e sem testes é rejeitado.
- O handoff deve conter objetivo, arquivos declarados (metadados), testes/resultados, decisões, problemas conhecidos, itens reutilizáveis, pendências e próximo passo quando aplicável.
- `requestReview: true` abre revisão. Reviewer/coordinator usa `collab_review_handoff` com `approved` ou `changes_requested`; `changes_requested` exige notas. O autor não revisa o próprio handoff.
- A revisão é consultiva; ela não substitui a validação real dos testes.
- `releasedLocks`/`retainedLocks` do handoff ainda não são preenchidos automaticamente. Libere seus locks explicitamente e registre a situação no campo de pendências/handoff.

## 8. Escrita colaborativa de arquivos — obrigatório

### 8.1 Fluxo padrão

1. **Leia:** `collab_read_file` com `path` relativo (ex.: `src/login.html`). Guarde `hash` e `version`.
2. **Reserve:** `collab_lock_acquire` com `path`, `intent` e, quando aplicável, `taskId`. Guarde `lockId`.
3. **Releia depois do lock:** chame `collab_read_file` novamente. O hash pode ter mudado entre sua primeira leitura e o lock. Use o hash **atual**.
4. **Altere:** `collab_apply_patch` com `lockId`, `expectedHash` e `replacements` exatas:
   ```json
   {
     "token": "<SESSION_TOKEN>",
     "path": "src/login.html",
     "lockId": "<LOCK_ID>",
     "expectedHash": "<SHA256_ATUAL>",
     "replacements": [
       {"oldText": "<trecho exato>", "newText": "<novo trecho>", "expectedOccurrences": 1}
     ],
     "note": "Ajuste do markup de login"
   }
   ```
   Para um arquivo novo, use `collab_create_file` com `lockId`; o diretório pai precisa existir. Para restaurar uma versão anterior, use `collab_restore_version` com `lockId`, `expectedHash` e `version`.
5. **Libere:** `collab_lock_release` com `lockId` depois da mutação. Se precisar manter o lock, renove-o antes do TTL e registre o motivo.
6. **Atualize o time:** publique progresso/mensagem e, ao concluir a tarefa, envie o handoff.

### 8.2 O que nunca fazer

- Não use editor nativo, `sed`, script, `git checkout`, `cp`/`mv` ou qualquer shell para **gravar** em arquivo compartilhado. Essas ferramentas não passam pelo lock/hash/checkpoint.
- Não escreva o arquivo inteiro como “patch” quando a ferramenta aceita substituições delimitadas.
- Não invente um `expectedHash` nem reuse hash de leitura antiga.
- Não adquira lock de arquivo que você não vai alterar “por precaução” por longos períodos.
- Não tente contornar `FORBIDDEN`, `LOCK_ALREADY_HELD`, `HASH_MISMATCH`, `VERSION_MISMATCH`, `PATCH_NOT_APPLICABLE` ou `CHECKPOINT_IN_PROGRESS` com ferramenta nativa.
- Não faça delete, rename/move ou criação de diretórios: essas operações não existem no MVP.

### 8.3 Conflito de lock

Se `collab_lock_acquire` retornar `LOCK_ALREADY_HELD`:

1. Pare de tentar escrever naquele arquivo.
2. Use `collab_lock_status` para confirmar dono, intenção e expiração.
3. Envie `collab_send_message` ao dono (mensagem direta) explicando o que precisa e propondo ordem/divisão.
4. Trabalhe em outro arquivo/tarefa enquanto espera.
5. Depois da liberação/expiração, adquira o lock novamente e **releia** o arquivo; não reuse o patch/hash antigo.
6. O coordinator não rouba lock. Não há preempção automática.

## 9. Checkpoint

`collab_checkpoint_begin` é do coordinator atual e exige **zero locks ativos no workspace**. Enquanto o checkpoint estiver aberto, `collab_apply_patch`, `collab_create_file` e `collab_restore_version` falham com `CHECKPOINT_IN_PROGRESS`.

- Consulte `collab_checkpoint_status` antes de planejar uma escrita em lote.
- Se receber `CHECKPOINT_IN_PROGRESS`, pare as mutações e aguarde o coordinator encerrar com `collab_checkpoint_end`.
- Qualquer coordinator **atual** de sala no mesmo workspace pode encerrar o checkpoint (regra anti-deadlock); não é necessário ser o criador.
- Checkpoint não executa Git, build ou shell. Testes e commits são responsabilidade humana/do fluxo externo.

## 10. Erros: pare e siga o hint

Respostas de erro têm o formato:

```json
{"ok": false, "tool": "collab_apply_patch", "error": {"code": "HASH_MISMATCH", "message": "...", "hint": "..."}}
```

| Código | Ação obrigatória |
|---|---|
| `FORBIDDEN` | Sem autorização de papel, principal, workspace ou sessão. Pare. Não tente outros IDs/tokens para “descobrir” acesso. |
| `SESSION_INACTIVE` | Sessão expirada/revogada. Pare. Peça novo convite e entre novamente; não há recuperação automática. |
| `LOCK_ALREADY_HELD` | Não escreva. Negocie com o dono e trabalhe em outro arquivo. |
| `LOCK_NOT_HELD`, `LOCK_EXPIRED` | Releia o estado; reacquire o lock se ainda precisar; nunca escreva sem lock válido. |
| `HASH_MISMATCH`, `VERSION_MISMATCH` | O arquivo mudou. Releia, revise o patch e tente de novo com o hash atual. |
| `PATCH_NOT_APPLICABLE` | O `oldText` não é exato/único. Releia e ajuste; não reescreva o arquivo inteiro. |
| `CHECKPOINT_IN_PROGRESS` | Escrita pausada. Aguarde `collab_checkpoint_end`. |
| `CONFLICT` | Estado mudou concorrentemente. Releia o estado e repita a operação de forma segura. |
| `NOT_FOUND` | Sala/tarefa/workspace/recurso errado ou removido. Confira IDs; não enumere recursos não autorizados. |
| `VALIDATION_FAILED`, `INVALID_STATE` | Corrija entrada/estado; não ignore a transição inválida. |
| `INTERNAL` | Falha interna. Pare, reporte ao operador com o `hint`; não faça retry cego. |

Erros HTTP do transporte:

- **401**: Bearer ausente, inválido ou revogado. Corrija a configuração do cliente; nunca reutilize um token revogado.
- **403**: identidade válida tentando reutilizar uma **sessão MCP de outro principal**. Não é a negativa normal de workspace/papel.
- **429**: muitas tentativas inválidas. Respeite `Retry-After`; não faça flood.

Negativas de **workspace/papel/coordinator** chegam como resultado de tool com `isError: true` e `error.code: "FORBIDDEN"` (HTTP 200 do ponto de vista do MCP), não como HTTP 403. Leia o envelope da tool.

## 11. Encerramento

1. Libere todos os locks que ainda possui.
2. Publique handoff/progresso final quando houver tarefa em andamento.
3. Se for o coordinator, transfira a coordenação antes de sair.
4. Chame `collab_leave` para revogar sua sessão de sala, ou mantenha a sessão ativa com `collab_heartbeat` se for continuar.
5. Não presuma que a sessão sobreviverá a uma reconexão/reinício do cliente. Ao voltar, comece por `collab_status`; se a sessão estiver inativa, use um novo convite.

## 12. Limites conhecidos

- O MCP não inicia/desperta aplicativos e não entrega push; polling é o fallback universal.
- `collab_list_workspaces` funciona só com o Bearer; a lista é filtrada pelo principal e não inclui roots/outros principals (seção 3.2).
- Autorização é por **workspace**, não por sala; `allowedPrincipals` é configurado somente no servidor.
- Autorização por workspace pode ser removida a qualquer momento; a próxima operação de arquivo/lock/checkpoint retorna `FORBIDDEN`, sem apagar histórico.
- Não há delete/rename/move/criação de diretórios.
- Locks são globais por workspace; duas salas no mesmo workspace disputam o mesmo arquivo.
- O modo cooperativo não impede escritas nativas. A disciplina é parte do protocolo.
- Um único processo deve abrir o SQLite; não rode múltiplos servidores sobre o mesmo arquivo.

## 13. Exemplos mínimos adicionais

Criar sala:

```json
{"displayName":"OpenCode","clientKind":"opencode","roomName":"Migracao login","workspaceId":"demo"}
```

Criar convite (coordinator):

```json
{"token":"<SESSION_TOKEN>","reviewer":true,"expiresInMinutes":60,"maxUses":2}
```

Entrar:

```json
{"inviteToken":"<INVITE_TOKEN>","displayName":"Codex","clientKind":"codex"}
```

Heartbeat:

```json
{"token":"<SESSION_TOKEN>"}
```

Atualizações:

```json
{"token":"<SESSION_TOKEN>","cursor":"0","limit":50}
```

Mensagem direta:

```json
{"token":"<SESSION_TOKEN>","body":"Vou trabalhar em src/login.html; pode liberar o lock quando terminar?","toAgentId":"<AGENT_ID>","kind":"chat"}
```

Lock:

```json
{"token":"<SESSION_TOKEN>","path":"src/login.html","intent":"Atualizar markup do login","taskId":"<TASK_ID>"}
```

Checkpoint:

```json
{"token":"<SESSION_TOKEN>"}
```

## 14. Referência

Consulte `TOOL_REFERENCE.md` nesta mesma pasta para a lista completa das 37 tools, campos aceitos e formas de retorno. Em caso de dúvida, a resposta real do servidor prevalece.
