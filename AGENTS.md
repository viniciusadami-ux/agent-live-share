# AGENTS.md — Collab MCP

> Documento central de contexto e decisões do projeto. `AGENTS.md` e `CLAUDE.md` devem permanecer sincronizados.

## 1. Estado atual

- **Nome público:** Agent Live Share. **Codename interno:** Collab MCP.
- **Repositório público:** `https://github.com/viniciusadami-ux/agent-live-share`.
- **Checkout:** use o diretório local do clone; não fixe caminho de máquina nos documentos públicos.
- **Fase:** **MVP local cooperativo integrado, autenticado por principal e autorizado por workspace; rodada 2 revisada com auditoria independente e adapters em nível de template.** Fundação, colaboração, workspace, locking e checkpoints estão ligados ao entrypoint real, com 37 ferramentas MCP e migrations até a **v30**.
- **Não é um MVP remoto pronto.** O binding continua exclusivamente loopback. A autenticação Bearer por principal, o vínculo sessão/principal e a **autorização por workspace via `allowedPrincipals`** estão implementadas, mas **Tailscale/acesso remoto ainda não foram configurados/validados** e exigem revisão de `allowedHosts`/proxy confiável antes do piloto remoto.
- O diretório NÃO é um repositório Git e nenhuma operação Git foi executada.
- Ambiente validado: Windows, Node.js `v24.19.0`, npm `11.17.0`. No PowerShell deste host usar `npm.cmd` (o `npm.ps1` é bloqueado pela ExecutionPolicy).
- Comandos disponíveis: `dev`, `start`, `build`, `typecheck`, `test`, `test:watch`, `smoke` (integrado), `smoke:foundation`, `smoke:integration`, `clean`, `auth:create`, `auth:list`, `auth:revoke`, `check:mcp` (seções 22–25).
- Já existem: contratos compartilhados, SQLite com migrations versionadas/transacionais, servidor MCP Streamable HTTP com **Bearer obrigatório**, health, diagnóstico, principals/credenciais com revogação, rate limiting, `allowedHosts`/proxy confiável, salas/convites/sessões por token **vinculadas ao principal**, mensagens/cursor, tarefas, handoffs, catálogo de workspaces com **lista exata de principals autorizados (`allowedPrincipals`, fail-closed)**, **descoberta de workspaces só com Bearer**, leitura/busca, patches com lock e hash, histórico/backup/restore, checkpoints e recuperação conservadora de journal.
- **200 testes em 24 arquivos** passando; typecheck, build, smokes e start real do `dist/` com credencial emitida pelo CLI validados. `npm audit --omit=dev` está **0 vulnerabilidades** (zod 4.6.7); restam apenas advisories dev do Vitest/Vite.
- **Adapters existem como templates/docs + `check:mcp`:** `adapters/opencode`, `codex`, `claude-code`, `generic-mcp`, `tailscale` e `shared/`. O script foi validado contra app local efêmera; **nenhum cliente real (OpenCode/Codex/Claude Code) ou Tailscale foi conectado/validado**.
- Ainda NÃO existem: binding externo/Tailscale configurado, bridge stdio, modo estrito, execução de shell/build por allowlist, operações Git, delete/rename/move de arquivos, UI/dashboard, OAuth, **tool/administrador remoto para alterar `allowedPrincipals`** (a lista é somente config do servidor), e granularidade de autorização por sala (hoje é por workspace).

## 2. Visão do projeto

Criar um **servidor MCP universal de colaboração entre agentes de programação**, permitindo que OpenCode, Claude Code, Codex e outros clientes compatíveis trabalhem juntos em um único workspace.

A analogia de produto é um **“Live Share para agentes”**, com uma diferença importante: os agentes trabalham em paralelo em arquivos diferentes, mas precisam reservar e negociar arquivos antes de editá-los. O MCP coordena o trabalho para impedir sobrescritas e conflitos concorrentes.

“Universal” significa compatibilidade entre clientes MCP, **não** exposição pública do servidor na internet.

## 3. Problema e objetivo

O primeiro caso de uso é acelerar a migração de um sistema TypeScript para HTML, CSS e JavaScript. Duas ou mais pessoas usarão agentes diferentes para trabalhar ao mesmo tempo, sem criar clones adicionais do repositório e sem depender apenas de instruções informais para evitar conflitos.

Objetivos:

- permitir que agentes de fornecedores diferentes compartilhem o mesmo ambiente de trabalho;
- dividir tarefas e arquivos entre os participantes;
- permitir comunicação assíncrona entre os agentes;
- evitar que dois agentes gravem simultaneamente no mesmo arquivo;
- negociar explicitamente quando mais de um agente precisar do mesmo arquivo;
- manter histórico, auditoria e possibilidade de recuperação;
- reduzir o tempo total da migração sem perder controle sobre as alterações.

O projeto deve ser genérico o suficiente para outros sistemas e tarefas depois dessa migração.

## 4. Decisões fundamentais

| Tema | Decisão |
|---|---|
| Workspace | Um único workspace real na máquina hospedeira; todos veem e alteram os mesmos arquivos |
| Clones | Não criar clones adicionais nem worktrees por agente |
| Git no caso de uso inicial | Todos trabalham na mesma branch de migração; commits somente em checkpoints estáveis |
| Hospedagem | O MCP roda inicialmente no PC do proprietário do workspace |
| Rede | Acesso remoto preferencialmente por Tailscale Serve encaminhando para loopback, sem abrir portas no roteador — **ainda não habilitado**; auth Bearer ja implementada |
| Protocolo | MCP com Streamable HTTP como transporte principal |
| Compatibilidade | OpenCode, Codex, Claude Code e outros clientes MCP; bridge stdio quando necessário |
| Núcleo | Independente de OpenAI, Anthropic, OpenCode ou qualquer outro fornecedor |
| Sessões | No MVP, cada participante mantém uma sessão ativa do seu agente |
| Acionamento | MCP não inicia ou “acorda” aplicativos fechados; automação desse tipo fica para uma fase futura |
| Coordenação | Coordenador configurável por sala; qualquer agente pode assumir esse papel |
| Concorrência | Lock exclusivo por arquivo para gravação, com heartbeat e expiração |
| Integridade | Toda gravação valida lock e versão/hash lido anteriormente |
| Mesmo arquivo | Não há edição simultânea do mesmo arquivo no MVP; os agentes negociam e trabalham sequencialmente nele |
| Persistência | SQLite para tarefas, mensagens, locks, versões e auditoria |
| Implementação | Node.js com SDK oficial do MCP; TypeScript no servidor é aceito mesmo que o sistema migrado use JavaScript puro |
| Segurança | Bearer por principal (transporte) + token de sessão de sala + **autorização por workspace (`allowedPrincipals`)**; workspaces allowlisted no servidor; auditoria; binding externo ainda pendente |
| Identidade | Principal = pessoa/cliente/instalação (Bearer, uma credencial por instalação); sessão de sala = ator dentro da sala, **vinculada ao principal** (migration 030) |
| Autorização por workspace | Cada workspace declara `allowedPrincipals: ["prin_..."]` (lista EXATA, sem wildcard). **Fail-closed**: campo ausente/vazio = nenhum principal autorizado. Revalidada em TODA chamada de workspace/locking/checkpoint e em create/join/create_invite. Sem migration nova e sem tabela editável remotamente |
| Escrita | No modo seguro, todas as gravações colaborativas passam pelo MCP |
| UI | Nenhuma interface web/dashboard é necessária no MVP |
| Catálogo de workspaces | Somente servidor, via `COLLAB_WORKSPACES_FILE`/`workspaces.json`; nenhuma tool aceita root ou lista de principals |
| Checkpoints | Qualquer coordinator ATUAL de sala no mesmo workspace pode encerrar; autoria preservada |

## 5. Modelo de operação

O servidor roda na máquina que contém o projeto compartilhado. Os agentes podem estar nessa mesma máquina ou em computadores remotos, mas as ferramentas de workspace executam as operações no host.

```text
OpenCode ────────────┐
Claude Code ─────────┤
Codex ───────────────┤
Outro cliente MCP ───┤
                     │
          Streamable HTTP (hoje: loopback, Bearer obrigatorio)
                     │
                     ▼
        Collaboration MCP Core no host
        ├─ salas e participantes
        ├─ mensagens e solicitações
        ├─ tarefas e distribuição
        ├─ locks e negociação
        ├─ arquivos, patches e versões
        └─ persistência e auditoria
                     │
                     ▼
          Workspace único no host
```

O núcleo conhece apenas conceitos genéricos: agente, sessão, sala, workspace, tarefa, mensagem, lock, arquivo, versão e checkpoint. O tipo de cliente é metadado para diagnóstico e compatibilidade, não uma dependência da lógica.

## 6. Participantes e papéis

Cada sala possui participantes com identidades próprias e pelo menos um coordenador definido pelo criador da sala.

Papéis previstos:

- **Coordinator:** analisa solicitações, examina o workspace, propõe a divisão do trabalho e acompanha dependências;
- **Worker:** executa tarefas e alterações no workspace;
- **Reviewer:** revisa alterações, testes e handoffs.

Um agente pode acumular papéis, por exemplo `coordinator + worker`.

No primeiro piloto:

- o OpenCode do proprietário inicia a solicitação e trabalha como worker;
- o Codex do amigo entra como coordinator e também pode trabalhar como worker;
- Claude Code e outros clientes entram depois sem exigir mudanças no núcleo.

O coordenador não é permanentemente associado ao Codex. Em outra sala, Claude Code ou OpenCode pode coordenar. A transferência é explícita e atômica; a sala é a fonte de verdade do coordinator.

## 7. Sessões ativas e limitações de comunicação

No MVP, cada pessoa abre seu cliente e executa o fluxo para entrar na sala colaborativa. O Codex do amigo, por exemplo, recebe uma instrução como “entre na sala e aguarde solicitações do coordenador/dos outros agentes”.

Enquanto a sessão estiver ativa, o agente:

- consulta ou aguarda atualizações;
- recebe solicitações;
- responde mensagens;
- executa tarefas;
- envia heartbeats de sessão e de locks;
- volta a consultar a sala após concluir cada etapa.

O MCP sozinho **não** abre aplicativos, inicia conversas ou força um modelo inativo a processar mensagens. O acionamento automático de um Codex, Claude Code ou outro agente exigiria um bridge/worker específico, como Codex app-server, e está fora do MVP.

A comunicação usa o menor denominador comum entre clientes:

- ferramentas MCP;
- caixas de mensagem;
- consulta de atualizações por cursor;
- polling não bloqueante como comportamento universal;
- heartbeat explícito para sessão e locks.

Extensões específicas de push, channels ou notificações de um cliente podem ser adicionadas futuramente, mas nunca serão requisito para o núcleo funcionar.

Se uma sessão cair ou for fechada, a colaboração daquele participante pausa. Seus locks expiram após o TTL, sem apagar os arquivos ou o histórico persistido. Não existe failover automático de coordinator: se o coordinator sair e não transferir, a sala fica sem coordinator ativo e precisa de intervenção.

## 8. Fluxo principal de trabalho

Exemplo: “migrar as telas de login e dashboard”.

1. O usuário envia o pedido ao seu OpenCode.
2. O OpenCode registra a solicitação na sala e a encaminha ao coordinator.
3. O coordinator lê o workspace pelo MCP e propõe uma divisão, por exemplo:
   - OpenCode: `login.html`, `login.css` e `login.js`;
   - Codex: `dashboard.html`, `dashboard.css` e `dashboard.js`;
   - arquivos compartilhados, como `api.js` e `global.css`, ficam para coordenação separada.
4. O OpenCode recebe a resposta, aceita sua tarefa e solicita os locks necessários.
5. Os agentes trabalham em paralelo em arquivos diferentes.
6. Eles publicam progresso, dúvidas, decisões e bloqueios na sala.
7. Se ambos precisarem do mesmo arquivo, negociam quem altera primeiro.
8. Ao concluir, cada agente libera seus locks e publica um handoff com arquivos alterados, testes, problemas e pendências.
9. Testes e commits acontecem em checkpoints combinados e estáveis.

## 9. Regras de concorrência

### Leitura e escrita

- Leituras podem ocorrer sem lock exclusivo.
- Toda escrita colaborativa deve possuir um lock válido para o arquivo.
- O agente deve ler a versão mais recente depois de adquirir o lock e antes de preparar o patch.
- A gravação usa substituições delimitadas (`oldText`/`newText`) com `expectedHash`, evitando reescrever o arquivo inteiro como único mecanismo.

### Lock exclusivo

Cada lock registra:

- workspace e caminho normalizado;
- agente e sessão proprietários;
- tarefa associada (opcional, validada contra a sala);
- intenção da alteração;
- horário de aquisição;
- heartbeat mais recente;
- expiração;
- status `held`/`released`/`expired`.

A aquisição é atômica: índice UNIQUE parcial sobre `(workspace_id, path_key)` quando `status='held'`, mais transação SQLite síncrona. Dois agentes não obtêm simultaneamente um lock de escrita válido para o mesmo arquivo.

Locks têm heartbeat explícito (`collab_lock_renew`), liberação (`collab_lock_release`) e expiração lazy. Não há heartbeat automático escondido na autenticação.

### Negociação de conflitos

Quando um arquivo já estiver reservado:

1. A requisição de lock informa quem é o proprietário, a intenção e a expiração, sem conceder acesso.
2. O requisitante envia uma mensagem explicando o que precisa alterar.
3. O proprietário pode liberar imediatamente, concluir e liberar, manter temporariamente com justificativa ou combinar uma divisão.
4. O requisitante pode aguardar ou trabalhar em outra tarefa independente.
5. Depois da liberação, o requisitante adquire o lock, relê o arquivo atualizado e usa o novo hash.

Não há preempção automática nem edição concorrente do mesmo arquivo no MVP. O coordinator não rouba lock de worker.

**Limitação entre salas:** o lock é global por workspace, então duas salas no mesmo workspace disputam o mesmo arquivo. A mensagem direta do MCP só existe dentro da própria sala; negociação entre salas diferentes depende de canal externo. O conflito expõe apenas metadados de coordenação (dono, intenção, expiração, sala), nunca conteúdo.

### Versões e prevenção de sobrescrita

Cada leitura retorna SHA-256 e versão. Toda gravação de arquivo existente informa `expectedHash`.

O MCP rejeita a operação quando:

- o lock não existe, expirou ou pertence a outro agente/sessão;
- o lock é de outro workspace ou de outro caminho;
- o hash atual difere do `expectedHash` (`HASH_MISMATCH`);
- o patch não pode ser aplicado com segurança (`PATCH_NOT_APPLICABLE`);
- o caminho está fora do workspace autorizado ou atravessa symlink/junction;
- há checkpoint aberto no workspace (`CHECKPOINT_IN_PROGRESS`);
- há journal de escrita pendente e não recuperável.

Locks e hashes são proteções complementares: o lock organiza a posse temporária; o hash detecta qualquer alteração inesperada, inclusive externa.

### Backups e auditoria

- Antes de cada mutação, um journal persistente guarda conteúdo anterior e pretendido.
- Cada mutação bem-sucedida publica uma versão `pre_mutation` (quando necessário) e uma versão `post` com autor/sessão/lock.
- O conteúdo integral fica em BLOB no SQLite, não em arquivos de backup dentro do workspace.
- Restaurar publica uma NOVA versão; o histórico nunca é apagado.
- A auditoria registra operação, resultado, sala/agente/sessão e código de erro, sem tokens, convites, conteúdo de arquivo ou root do host.
- Operações de leitura pura não são auditadas por padrão, para evitar ruído.

## 10. Modos de proteção das ferramentas nativas

O MCP controla somente as gravações que passam por ele. Agentes locais como OpenCode e Claude Code podem possuir ferramentas nativas de escrita e shell capazes de alterar o disco diretamente.

### Modo cooperativo — atual

- Instruções obrigatórias determinam uso dos locks e das ferramentas MCP.
- Clientes genéricos funcionam sem plugins específicos.
- A disciplina depende de o agente seguir o protocolo.
- O servidor aplica todas as garantias nas chamadas que recebe, mas não consegue interceptar escritas locais externas.
- Escritas nativas podem ignorar locks, checkpoints e hash; isso é uma limitação conhecida, não uma promessa de proteção universal.

### Modo estrito — evolução planejada

- Ferramentas nativas de escrita são desabilitadas ou interceptadas por permissões, hooks ou plugins.
- Toda alteração precisa passar pelo MCP.
- A configuração varia por cliente e fica nos adaptadores.
- Shell arbitrário também precisa ser considerado, pois pode contornar uma restrição apenas às ferramentas de edição.

Não declarar que locks universais são infalíveis enquanto escritas nativas puderem ignorá-los.

## 11. Git, testes e checkpoints

No caso de uso inicial, todos trabalham na mesma branch de migração já existente. Não haverá branches individuais por tarefa nem clones adicionais.

Consequências e regras:

- um commit imediato pode incluir trabalho inacabado de outro agente;
- commits devem ocorrer somente quando os participantes estiverem em um estado estável;
- builds, testes de integração e commits usam um checkpoint global;
- durante o checkpoint, novas gravações são pausadas no workspace;
- locks são coordenados antes do checkpoint: para iniciar, nenhum lock ativo pode existir;
- o checkpoint registra participantes/autoria, nota e resultados de testes;
- o PR final da branch de migração para `main` será revisado/aprovado pelas pessoas, não integrado automaticamente pelo MCP.

O MCP não executa operações Git no MVP. Git continua sendo a fonte de histórico do projeto real; o histórico interno do MCP serve para concorrência, auditoria e recuperação operacional.

Comandos de build e teste oferecidos pelo servidor devem usar allowlist. Não expor shell arbitrário por padrão para agentes remotos.

### Regra final de checkpoints (anti-deadlock)

1. **Iniciar:** somente o coordinator ATUAL de uma sala autorizada. Exige zero locks ativos no workspace.
2. **Encerrar:** qualquer coordinator ATUAL de sala que aponte para o MESMO workspace pode encerrar o checkpoint aberto, não apenas o criador.
3. `created_by_agent_id` preserva quem abriu; `sealed_by_agent_id` registra quem encerrou.
4. Um evento `checkpoint.sealed` é gravado na sala de origem do checkpoint com o autor real do encerramento.
5. A autoridade é relida da tabela `collab_rooms` no momento da operação; um snapshot antigo de sessão não permite que o ex-coordinator encerre.
6. Isso elimina o deadlock em que o criador transferia a coordenação e ninguém conseguia encerrar a pausa.

## 12. Compatibilidade entre clientes

### Conexão nativa

OpenCode, Codex e Claude Code suportam MCP remoto por HTTP e devem se conectar ao endpoint Streamable HTTP com `Authorization: Bearer <token>` configurado em cada cliente. A autenticação de transporte está implementada (seção 23); o acesso remoto/Tailscale ainda não foi configurado.

### Bridge stdio

Clientes que aceitem apenas MCP local por stdio usarão um proxy leve:

```text
Agente ↔ stdio ↔ collab-mcp-stdio ↔ HTTP ↔ Collaboration MCP Core
```

O proxy apenas transporta mensagens. Ele não mantém uma segunda implementação de locks, tarefas ou workspace e deve oferecer as mesmas capacidades do acesso HTTP. O bridge ainda não existe.

### Regras de compatibilidade

- Negociar uma revisão MCP estável e comum pelos SDKs, sem exigir extensões recentes para o fluxo básico.
- Não depender de recursos exclusivos de OpenCode, Claude Code ou Codex no núcleo.
- Manter ferramentas e resultados com contratos simples e consistentes.
- Disponibilizar instruções/configuração por cliente em adaptadores separados.
- Agentes executados apenas em nuvem precisam conseguir alcançar a rede/endpoint do host; compatibilidade MCP não elimina requisitos de rede.

## 13. Segurança

- Usar Tailscale ou outra rede privada equivalente para o acesso remoto inicial.
- Não expor o servidor diretamente à internet nem configurar port forwarding no MVP.
- Autenticação de transporte (Bearer por principal), autorização por identidade/sessão e revogação de credenciais estão **implementadas** (seção 23). O binding continua SOMENTE loopback; Tailscale/acesso remoto ainda não configurados.
- Emitir um token Bearer por pessoa/cliente/instalação (principal), com possibilidade de revogação imediata; o token de sessão de sala continua separado.
- Exigir `Authorization: Bearer` em TODAS as rotas `/mcp` (POST/GET/DELETE e handshake); `/health` permanece público e sem segredos.
- 401 usa corpo único e `WWW-Authenticate: Bearer` para header ausente, formato inválido, token inexistente ou revogado — sem revelar existência. 403 apenas para identidade válida sem autorização sobre uma sessão MCP de outro principal. 429 para excesso de tentativas inválidas.
- Rate limiting de Bearer inválido por endereço do par, em memória, sem guardar tokens; `X-Forwarded-For` só é confiável com `COLLAB_TRUST_PROXY=1` e par allowlisted.
- Validar Host header contra `COLLAB_ALLOWED_HOSTS` explícito, sem wildcard; binding externo continua proibido.
- Não gravar tokens, segredos ou credenciais no repositório ou em documentação.
- Não confiar identidade apenas em `displayName` ou `client` informados pelo agente.
- Associar permissões à identidade autenticada e à sessão.
- Configurar workspaces permitidos somente no servidor; um agente remoto não pode escolher qualquer diretório do host, root ou lista de principals.
- **Autorizar por workspace com `allowedPrincipals`**: lista EXATA de `PrincipalId` (`prin_...`), sem wildcard, sem nomes/displayName/tokens. Campo ausente, `null` ou `[]` = **fail-closed** (ninguém autorizado). IDs validados no startup contra `isPrincipalIdFormat`; entradas inválidas/duplicadas derrubam o startup. Não se valida a existência da credencial (ela pode ser emitida depois); `auth:revoke` continua bloqueando o transporte.
- **Revalidar a autorização em TODA chamada**: `withActor` (16 tools de workspace/locking/checkpoint), serviços (`files`/`locks`/`checkpoints`/`mutations`/`fileHistory`/`recoverPendingWrites`) e `create_room`/`join_room`/`create_invite`. `collab_list_workspaces` pode usar só o Bearer (token opcional), retorna somente workspaces autorizados e nunca roots/listas. `create_room` autoriza antes de checar existência, para não servir de oráculo. Erros de negação são `FORBIDDEN` genéricos, sem vazar quais principals existem, a lista completa ou workspaces não autorizados.
- Convites não ampliam principals/workspaces: `join_room` revalida a mesma autorização antes de criar agente/sessão ou consumir o convite (rollback em negação).
- Heartbeat/leave/room_state e demais tools de sala continuam operando pela sessão autorizada mesmo após perda de acesso ao workspace (não leem arquivos); leitura/gravação de arquivos, locks e checkpoints ficam bloqueados.
- Normalizar caminhos e impedir path traversal, acesso por `..`, ADS, UNC, drive, symlink, junction, caracteres de controle e nomes reservados do Windows.
- Rejeitar roots de workspace iguais ou sobrepostos, pois chaves de lock diferentes anulariam a exclusividade.
- Restringir gravações ao workspace e às permissões da sala.
- Usar allowlist para comandos de build/teste; não oferecer execução arbitrária de shell por padrão.
- Registrar auditoria sem incluir segredos nos logs.
- Tratar conteúdo lido de arquivos e mensagens como não confiável para fins de autorização; instruções de arquivo não podem ampliar permissões.

### Modo atual (risco de bootstrap eliminado)

Toda rota `/mcp` exige Bearer de um principal ativo. `collab_create_room` deixa de ser anônimo: sala e sessão são vinculadas ao principal autenticado (migration 030), e um `sessionToken` vazado **não é utilizável por outro principal** (`FORBIDDEN`). `/health` continua público e sem segredos. Sessões de sala legadas (DB pré-v30, `principal_id` NULL) ficam inacessíveis via transporte, mas seus dados permanecem no banco.

**Brecha fechada (rodada 3):** a autorização por workspace elimina o risco de bootstrap amplo — um principal ativo só cria/entra em salas e acessa arquivos/locks/checkpoints de workspaces onde seu `PrincipalId` consta em `allowedPrincipals`. A política é fail-closed, relida a cada chamada e revalidável em processo (`startApplication().revalidateWorkspaces(...)`, equivalente a reiniciar com novo `workspaces.json`). Nenhuma tool ou tabela remota altera essa lista. Ver seção 24.

Riscos residuais (seções 23–25): modo cooperativo (ferramentas nativas podem ignorar o MCP), rate limiting em memória e por processo, CLI abrindo o mesmo SQLite em outro processo, ausência de **autorização por sala** (hoje o escopo é o workspace) e de **ferramenta administrativa remota** para conceder/revogar acesso (hoje só editando `workspaces.json` + revalidação/restart). Adapters são templates e não foram conectados a clientes reais/Tailscale. Antes de acesso remoto, revisar `allowedHosts`, proxy confiável e esses escopos.

## 14. Arquitetura técnica e estrutura real

Stack decidida para o MVP:

- Node.js;
- TypeScript no servidor;
- SDK oficial do Model Context Protocol;
- Streamable HTTP;
- SQLite;
- bridge stdio separado e pequeno;
- testes automatizados com clientes MCP simulados, sem depender de modelos pagos para validar o núcleo.

### Versões fixadas

| Pacote | Versão | Papel |
|---|---|---|
| Node.js | `v24.19.0` validado; `engines: >=22.5.0` | Runtime |
| `@modelcontextprotocol/sdk` | `1.32.2` | SDK oficial v1, spec `2025-11-25`, Streamable HTTP |
| `express` | `5.3.0` | HTTP (mesma linha `^5.2.1` exigida pelo SDK) |
| `zod` | `4.6.7` (uso via subpath `zod/v4`) | Schemas das tools; atualizado por causa do advisory de exaustão de memória |
| `better-sqlite3` | `13.2.0` | Driver SQLite síncrono, com prebuilds para Windows |
| `typescript` | `5.9.3` | Build/typecheck |
| `tsx` | `4.23.15` | Execução TS em dev/smoke |
| `vitest` | `3.2.7` | Testes |
| `@types/node` | `24.19.2` | Tipos do runtime |

A linha **v1** do SDK é o baseline operacional: é o denominador comum entre OpenCode, Codex e Claude Code hoje (`LATEST_PROTOCOL_VERSION = "2025-11-25"`). A v2 (`@modelcontextprotocol/server` / `@modelcontextprotocol/client`, spec `2026-07-28`) fica para depois de testes de interoperabilidade.

### Estrutura real

```text
agent-live-share/
├── package.json / package-lock.json
├── tsconfig.json / tsconfig.build.json / vitest.config.ts
├── .gitignore / .env.example
├── workspaces.example.json          # modelo versionavel, sem root real
├── fixtures/demo-workspace/         # fixture local para smoke/manual
├── adapters/                        # templates/docs: opencode, codex, claude-code, generic, tailscale, shared
│   └── scripts/check-mcp-connection.ts
├── src/
│   ├── index.ts                     # entrypoint real (usa startApplication)
│   ├── application.ts               # composicao integrada + fail-fast de roots
│   ├── cli/auth.ts                  # CLI: auth:create / auth:list / auth:revoke
│   ├── config/
│   │   ├── env.ts                   # host/porta/db/log, allowedHosts, trustedProxy, rateLimit
│   │   ├── logger.ts                # logger sem segredos
│   │   ├── workspaces.ts            # COLLAB_WORKSPACES_FILE / workspaces.json
│   │   └── index.ts
│   ├── contracts/                   # IDs (incl. PrincipalId), erros, primitivas, papéis, entidades, principal.ts (validador de PrincipalId)
│   ├── persistence/                  # SQLite, migrations v1 e v30, metadata
│   ├── collaboration/               # migration v2, 20 tools, auth por token vinculada ao principal, WorkspaceDirectory.principalCanAccess
│   ├── workspace/                   # migration v10, 8 tools + 3 checkpoints, authorization.ts (politica compartilhada fail-closed)
│   ├── locking/                     # migration v20, 5 tools
│   └── server/
│       ├── auth/                    # principalContext (ALS), principals, rateLimit, transportAuth
│       ├── httpApp.ts               # /mcp (POST/GET/DELETE) + /health + middleware de auth
│       ├── httpServer.ts            # startServer (auth required por padrao)
│       ├── mcpServer.ts             # contexto por sessao MCP com principal congelado
│       ├── diagnostics.ts           # collab_status com principalId/name e authEnabled
│       ├── composition.ts, lifecycle.ts, index.ts
├── tests/
│   ├── foundation/                  # 4 arquivos + smoke da fundação
│   ├── collaboration/               # 4 arquivos
│   ├── workspace/                   # 6 arquivos
│   ├── locking/                     # 1 arquivo
│   ├── integration/                 # app, config (allowedPrincipals), multicliente e smoke integrado
│   ├── auth/                        # transport, binding, principals, workspace-authorization
│   ├── adapters/                    # parse de templates, secrets e check:mcp em app real
│   └── helpers/auth.ts              # emissao de credencial de teste
└── .tmp-tests/                      # temporários (ignorado, limpo ao final)
```

### Estrutura futura (não criada)

```text
stdio-proxy/         # adaptador stdio → HTTP
```

Manter a implementação modular, mas simples. Não introduzir microsserviços, filas externas, PostgreSQL, CRDT, interface web ou um sistema distribuído sem necessidade comprovada.

## 15. Contrato funcional implementado

### Sala e presença

- criar sala com workspaceId operacional validado no catálogo;
- criar/revogar convite;
- entrar com convite;
- heartbeat e saída;
- estado da sala, participantes, papéis e coordinator;
- transferência explícita de coordenação;
- consulta de atualizações por cursor.

### Comunicação

- mensagem de sala e mensagem direta;
- solicitação de plano com mensagem correlata;
- resposta à solicitação;
- listagem de solicitações;
- eventos persistentes com visibilidade `room`/`direct`/`self`.

### Tarefas

- propor, atribuir, aceitar, iniciar, bloquear/desbloquear, reportar progresso, concluir e cancelar;
- dependências entre tarefas;
- handoff obrigatório com objetivo e resultados de teste para conclusão;
- revisão por reviewer/coordinator;
- listagem de tarefas e handoffs.

### Workspace e concorrência

- listar workspaces **autorizados ao principal** (somente id/name; sem lista de principals) **antes ou depois de ter sala**, usando só o Bearer;
- criar/entrar em sala somente em workspace onde o principal consta em `allowedPrincipals`;
- listar e pesquisar arquivos;
- ler conteúdo, hash e versão;
- aplicar patch delimitado com `expectedHash` e lock;
- criar arquivo novo (pai precisa existir);
- consultar histórico e restaurar versão;
- adquirir, renovar, liberar e consultar locks;
- iniciar, encerrar e consultar checkpoints;
- recuperação conservadora de journal de escrita.

Toda ferramenta devolve erros úteis e acionáveis, indicando o motivo e o próximo passo possível. Erros inesperados são genéricos na resposta MCP; detalhes ficam nos logs locais.

## 16. Handoff obrigatório

Ao concluir uma unidade de trabalho, o agente deve publicar:

- tarefa e objetivo;
- arquivos criados, alterados ou removidos;
- locks liberados ou ainda retidos, com justificativa;
- testes executados e resultados;
- decisões relevantes;
- problemas conhecidos;
- arquivos/utilitários disponíveis para reutilização;
- pendências e próximo passo sugerido.

O handoff atual aceita objetivo, mudanças, testes, decisões, problemas, itens reutilizáveis, pendências e próximo passo. Os campos `releasedLocks`/`retainedLocks` ainda não são preenchidos automaticamente; o agente deve liberar locks explicitamente e registrar a situação no texto do handoff até a integração ser implementada.

Não declarar uma tarefa concluída apenas porque o patch foi escrito; validar o resultado compatível com o projeto.

## 17. Fora de escopo no MVP

- Iniciar ou “acordar” aplicativos fechados.
- Controlar Codex app-server, OpenCode API, Claude Agent SDK ou APIs proprietárias no núcleo.
- Edição simultânea do mesmo arquivo com OT/CRDT.
- Execução remota arbitrária de shell.
- Clones, worktrees ou branches automáticas por agente.
- Merge automático da migração em `main`.
- Serviço SaaS público ou multiempresa.
- Dashboard web.
- Orquestração autônoma infinita de agentes.
- Migração do servidor para PostgreSQL sem necessidade operacional.
- Delete, rename/move e criação automática de diretórios no workspace.
- UI, bridge stdio e adapters por cliente nesta rodada.

## 18. Ordem de implementação

1. **[CONCLUÍDO — fundação]** Projeto Node/TypeScript e servidor MCP Streamable HTTP básico.
2. **[CONCLUÍDO — fundação]** Contratos genéricos de sala, agente, sessão, mensagem, tarefa, workspace e lock.
3. **[CONCLUÍDO — fundação]** Persistência SQLite, migrations e testes com clientes MCP simulados.
4. **[CONCLUÍDO]** Ferramentas de workspace sobre fixture isolada.
5. **[CONCLUÍDO]** Locks atômicos, heartbeat, expiração, hashes, patches, backups e recuperação.
6. **[CONCLUÍDO]** Mensagens, solicitações/respostas, cursor, tarefas e handoffs.
7. **[CONCLUÍDO]** Papéis configuráveis e fluxo de planejamento pelo coordinator.
8. **[CONCLUÍDO]** Autenticação de sessão/convite, autorização, validação de caminhos e auditoria.
9. **[CONCLUÍDO]** Integração executável dos módulos no entrypoint, configuração de workspaces e testes multicliente reais.
10. **[CONCLUÍDO — rodada 2]** Autenticação de transporte HTTP (Bearer por principal), autorização por identidade/sessão, revogação, rate limiting, `allowedHosts`/proxy confiável, CLI administrativo e migration 030 (seção 23).
11. **[CONCLUÍDO — rodada 3]** Autorização de transporte **por workspace** via `allowedPrincipals` (fail-closed), revalidada em toda chamada, cobrindo create/join/list/read/lock/checkpoint (seção 24). Sem migration nova; v30 permanece intacta.
12. **Próximo** Granularidade de autorização por sala e ferramenta administrativa para conceder/revogar acesso sem editar `workspaces.json`.
13. **[CONCLUÍDO — templates]** Instruções/adaptações para OpenCode, Codex, Claude Code, cliente genérico e runbook Tailscale em `adapters/**`, com `check:mcp`; **conexão real de cada cliente ainda não validada**.
14. **Próximo** Acesso privado remoto (Tailscale Serve) somente após revisar `allowedHosts`, proxy confiável e os escopos de autorização — **ainda não configurado**.
15. **Próximo** Piloto OpenCode + Codex em workspace real.
16. **Próximo** Conectar Claude Code à mesma sala sem modificar o núcleo; implementar e validar o bridge stdio.
17. **Depois** Avaliar adaptadores de modo estrito; advisories dev do Vitest/Vite permanecem (runtime de produção está sem advisories).

## 19. Critérios de aceite do MVP

### Colaboração — verificado localmente

- Dois ou mais agentes entram na mesma sala com identidades distintas por conexões MCP distintas.
- Um agente envia solicitação e outro responde enquanto a sessão está ativa.
- O coordinator distribui tarefas e os workers recebem suas atribuições.
- Mensagens, tarefas e handoffs permanecem disponíveis após reiniciar o servidor.

### Workspace e concorrência — verificado localmente

- Todos os participantes leem exatamente os mesmos arquivos do host.
- Alterações feitas por um agente ficam imediatamente visíveis aos demais.
- Dois clientes não conseguem obter lock de escrita simultâneo para o mesmo arquivo.
- Um agente consegue solicitar negociação e outro consegue liberar o arquivo.
- Locks abandonados expiram sem intervenção manual.
- Uma gravação sem lock válido é rejeitada.
- Uma gravação baseada em hash desatualizado é rejeitada mesmo com lock válido.
- Uma versão anterior pode ser recuperada.
- Reiniciar o servidor não apaga tarefas, mensagens, versões ou histórico.
- Checkpoint pausa escrita e a transferência de coordinator não deixa a pausa presa.

### Compatibilidade e segurança — auth local verificada, transporte remoto pendente

- OpenCode e Codex participam do piloto usando o mesmo contrato — ainda não executado.
- Claude Code conecta depois sem alteração da lógica central — ainda não executado.
- O bridge stdio oferece paridade funcional — ainda não implementado.
- Nenhum agente acessa caminhos fora do workspace autorizado pelo MCP — coberto por validação e testes.
- Tokens/hashes não aparecem no repositório, logs, health, auditoria ou respostas — coberto por testes.
- Comandos arbitrários não ficam disponíveis — não há tool de shell.
- **Autenticação de transporte Bearer, revogação imediata, rate limiting, vínculo sessão/principal, 401/403/429, `allowedHosts` e migração v20→v30 — cobertos por testes (seção 23).**
- **Autorização por workspace (`allowedPrincipals`) fail-closed, filtragem de `list_workspaces`, negação de create/join por principal não listado, bloqueio de read/patch/lock/checkpoint após revalidação e não-vazamento da lista — cobertos por testes (seção 24).**
- **Descoberta de workspace com `collab_list_workspaces` só com Bearer (sem sessão de sala), sem root/lista de principals, e `create_room` sem oráculo de existência — coberto por testes.**
- **Adapters são templates/docs + `check:mcp`; nenhum cliente real ou Tailscale foi conectado/validado nesta máquina.**
- **Acesso remoto privado (Tailscale), autorização por sala e administração remota de `allowedPrincipals` ainda NÃO implementados/configurados — pré-requisitos do piloto remoto.**

### Piloto real — não executado

- Dois agentes migram duas telas independentes no mesmo workspace.
- Não há sobrescritas silenciosas.
- Conflitos por arquivos compartilhados são negociados e resolvidos sequencialmente.
- O checkpoint final registra testes e pendências antes de qualquer commit.

## 20. Regras para agentes que desenvolvem este MCP

- Ler este documento antes de alterar arquitetura ou comportamento.
- Preservar o núcleo independente de fornecedor.
- Fazer mudanças mínimas e modulares, sem adicionar complexidade fora do escopo.
- Implementar primeiro contra clientes simulados e fixtures, não diretamente no projeto real.
- Tratar concorrência, autorização e validação de caminhos como parte do comportamento, não como melhorias posteriores.
- Adicionar testes para regras de lock, expiração, versão e isolamento do workspace.
- Não declarar proteção universal contra conflitos se ferramentas nativas puderem contornar o MCP.
- Não declarar que mensagens chegam automaticamente a aplicativos fechados.
- Não incluir segredos em configurações versionadas.
- Não abrir binding externo, Tailscale ou porta pública sem revisar `allowedHosts`, proxy confiável e autorização por workspace/sala; a autenticação de transporte já existe.
- Atualizar `AGENTS.md` e `CLAUDE.md` sempre que decisões, estrutura, comandos ou escopo mudarem.

## 21. Decisões ainda abertas

- versão exata do protocolo MCP após testes de interoperabilidade (baseline: `2025-11-25` via SDK `1.32.2`);
- duração padrão dos locks e intervalos de heartbeat (hoje: lock 5 min, sessão 15 min);
- política e retenção dos backups BLOB;
- sintaxe e limites futuros de patches mais ricos;
- formato final dos comandos de configuração por cliente;
- ordem e formato do onboarding das salas;
- suporte futuro a OAuth além dos tokens individuais;
- adaptadores de modo estrito que serão implementados primeiro;
- bridge futuro para acionamento automático de agentes;
- distribuição por npm/npx ou outro formato;
- política de failover de coordinator quando a sessão atual expira;
- atualização major do Vitest (advisories dev; exige 5.x) e eventual troca de runtime de teste;
- autorização por sala/role e administração remota de `allowedPrincipals`.

### Decisões fechadas na fundação

1. SDK oficial v1 `1.32.2` / spec `2025-11-25` como baseline operacional; v2 fica para depois de testes de interoperabilidade.
2. Driver SQLite `better-sqlite3@13.2.0` (síncrono, estável, prebuilds para Windows); `node:sqlite` foi avaliado e descartado por ainda ser experimental.
3. `zod` via subpath `zod/v4`, satisfazendo o peer `^3.25 || ^4.0`; em 2026 foi atualizado de `3.25.76` para `4.6.7` (compatível com o SDK e toda a suíte) para corrigir o advisory de exaustão de memória.
4. Convenção `src/contracts/**` para contratos compartilhados, com barril único.
5. Binding exclusivamente loopback, com rejeição explícita de `0.0.0.0`, `::` e hosts públicos enquanto não houver tokens.
6. `journal_mode` padrão (DELETE): um único processo abre o arquivo e evita artefatos `-wal`/`-shm` no Windows.
7. Migration de fundação `version: 1` cria apenas `app_metadata`; `schema_migrations` é criada pelo runner.
8. TypeScript `5.9.3` e Vitest `3.2.7` em vez dos majors mais novos, por maturidade e compatibilidade entre si.
9. `npm.cmd` em vez de `npm.ps1` no PowerShell deste host (ExecutionPolicy).

### Decisões fechadas na integração

1. Configuração de workspaces via JSON local (`COLLAB_WORKSPACES_FILE`), default `./workspaces.json`; ausência do default resulta em catálogo vazio, e arquivo explícito ausente falha o startup.
2. `rootPath` relativo é resolvido contra o diretório do JSON; roots nunca são aceitos por tool remota.
3. `startApplication` separa a composição executável de `startServer`, permitindo testes programáticos com `definitions` injetadas.
4. Roots iguais ou sobrepostos são rejeitados no catálogo para não burlar locks por `workspace_id`.
5. Checkpoint pode ser encerrado por qualquer coordinator ATUAL do mesmo workspace; `created_by` e `sealed_by` são preservados e um evento é registrado na sala de origem.
6. Diagnóstico não expõe caminho do SQLite nem root; erros inesperados não serializam mensagem crua do filesystem.
7. Smoke padrão (`npm run smoke`) exercita a aplicação integrada; o smoke da fundação permanece em `smoke:foundation`.

### Decisões fechadas na rodada 2 (autenticação de transporte)

1. **Bearer estático por principal**, sem OAuth nesta etapa: 32 bytes aleatórios, prefixo `collab_p_`, apenas SHA-256 persistido; token em claro exibido UMA vez pelo CLI.
2. **Migration 030**: `transport_principals` + `collab_sessions.principal_id` (ALTER condicional). Sessões legadas ficam com `principal_id` NULL e inacessíveis via transporte, preservando os dados.
3. **`authenticateCollaborationSession` exige `principalId`**: `sessionToken` vazado não é utilizável por outro principal (`FORBIDDEN`).
4. **Identidade propagada por três vias**: `req.auth` no shape `AuthInfo` do SDK (token redigido), `AsyncLocalStorage` (`runWithPrincipal`) e, como autoridade primária, o principal **congelado no `ToolContext` da sessão MCP**. Nenhum rewrite no SDK; nenhum `X-*` inventado é confiável.
5. **`startServer` exige auth por padrão**; `disabled-for-tests` é opção tipada e explícita usada só nos testes da fundação. `startApplication`/entrypoint nunca a usam.
6. **401 com corpo único** (`{"error":"unauthorized"}` + `WWW-Authenticate: Bearer`) para todos os motivos; **403** só para sessão MCP de outro principal; **429** para excesso de tentativas inválidas; `/health` público.
7. **Rate limiting** por endereço do par, em memória, sem guardar tokens; token válido nunca é bloqueado e limpa o histórico.
8. **`COLLAB_ALLOWED_HOSTS`** explícito (sem wildcard) e **`COLLAB_TRUST_PROXY`** desabilitado por padrão; `X-Forwarded-For` só com proxy allowlisted. Binding continua loopback.
9. **CLI** `auth:create` / `auth:list` / `auth:revoke` (`src/cli/auth.ts`), operações curtas no mesmo SQLite com `busy_timeout`.
10. **Principal ≠ sessão de sala**: credencial por pessoa/cliente/instalação; `sessionToken` por ator dentro da sala; `collab_leave` revoga a sessão de sala, `auth:revoke` bloqueia o transporte.
11. `collab_status` expõe apenas `principalId`/`principalName`/`authEnabled` (dados seguros); health expõe `auth.enabled`.

### Decisões fechadas na rodada 3 (autorização por workspace)

1. **`allowedPrincipals`** é uma lista EXATA de `PrincipalId` por workspace em `workspaces.json` (ou `definitions` injetadas); não há wildcard, nomes, displayName ou tokens Bearer. Ausente/`null`/`[]` = **fail-closed** (nenhum principal autorizado).
2. **Validação no startup**: `isPrincipalIdFormat` (`prin_...`) no loader de config e na política; entradas inválidas, não-array ou duplicadas derrubam o startup (`ConfigError`). Não se valida a EXISTÊNCIA da credencial — ela pode ser emitida depois; `auth:revoke` permanece o bloqueio de transporte.
3. **Sem migration nova**: a política fica em memória, criada UMA vez em `startApplication` e compartilhada por todas as sessões MCP. `ws_catalog` continua sendo apenas espelho de roots (já existente). Nenhuma tabela com allowed lists é editável remotamente. v40 permanece reservada; v30 intacta; health segue `migrationVersion: 30` / `appliedMigrations: 5`.
4. **`WorkspaceAuthorization.replace()` / `revalidateWorkspaces()`** revalida a config em processo (equivalente a reiniciar com novo `workspaces.json`): valida tudo de novo e troca a política; remoção de principal bloqueia a PRÓXIMA chamada de qualquer sessão, preservando salas, versões e histórico. Não é uma tool MCP.
5. **Camadas de checagem**: `withActor` (16 tools), serviços (`files`/`locks`/`checkpoints`/`mutations`), `WorkspaceDirectory.principalCanAccess` (create/join/create_invite) e `collab_list_workspaces` (filtragem). Negação é `FORBIDDEN` genérico, sem enumerar principals/workspaces.
6. **`WorkspaceDirectory.principalCanAccess` é obrigatório**; `create_room`/`join_room`/`create_invite` negam (fail-closed) se o método estiver ausente. O helper estático de testes devolve `true` explicitamente (nunca usado em produção).
7. **Convites não ampliam acesso**: `join_room` revalida antes de criar agente/sessão e antes de consumir o convite (rollback em negação).
8. **Heartbeat/leave/room_state e demais tools de sala** continuam pela sessão autorizada após perda de acesso ao workspace (não leem arquivos); apenas operações de workspace/locking/checkpoint são bloqueadas.
9. **`collab_status`** continua expondo só o próprio `principalId`/`principalName`; a lista completa nunca aparece em respostas, erros, auditoria ou health.

## 22. Integração executável — registro da rodada 1

### Scripts (usar `npm.cmd` no PowerShell)

| Script | Comando | Status |
|---|---|---|
| `dev` | `tsx watch src/index.ts` | Sobe a aplicação integrada |
| `start` | `node dist/index.js` | Exercitado com `dist/` compilado e workspace fixture |
| `build` | `npm run clean && tsc -p tsconfig.build.json` | OK |
| `typecheck` | `tsc -p tsconfig.json --noEmit` | OK |
| `test` | `vitest run` | OK — **200 testes / 24 arquivos** (após auditoria da rodada 2) |
| `test:watch` | `vitest` | Disponível |
| `smoke` | `tsx tests/integration/smoke.ts` | OK — app integrada, 2 clientes autenticados, 37 tools, lock/patch |
| `smoke:integration` | `tsx tests/integration/smoke.ts` | Alias explícito |
| `smoke:foundation` | `tsx tests/foundation/smoke.ts` | OK — fundação isolada |
| `clean` | remove `dist/` | OK |
| `auth:create` | `tsx src/cli/auth.ts create` | Cria principal; exibe o Bearer token UMA vez |
| `auth:list` | `tsx src/cli/auth.ts list` | Lista id/name/status, sem token/hash |
| `auth:revoke` | `tsx src/cli/auth.ts revoke` | Revoga principal; bloqueia o transporte |
| `check:mcp` | `tsx adapters/scripts/check-mcp-connection.ts` | Conecta com Bearer, lista tools e chama `collab_status`; valida contra app local efêmera, sem ação destrutiva e sem imprimir token |

### Endpoints

- `POST /mcp` — inicialização e chamadas MCP (Streamable HTTP; sessões via `Mcp-Session-Id`).
- `GET /mcp` — stream SSE da sessão.
- `DELETE /mcp` — encerramento da sessão.
- `GET /health` — JSON com status, versão do protocolo, driver SQLite, migration atual, total de migrations, `auth.enabled`, endpoints, uptime e sessões do transporte. Não contém roots, tokens, hashes ou caminho do SQLite.
- Porta padrão `3100`; `COLLAB_PORT=0` produz porta efêmera real.
- **Todas as rotas `/mcp` exigem `Authorization: Bearer`** (seção 23); `/health` é público.

`createMcpExpressApp({ host, allowedHosts })` do SDK aplica `express.json()` e validação explícita de Host (proteção contra DNS rebinding). `loadConfig` rejeita qualquer host de binding que não seja `127.0.0.1`, `localhost` ou `::1`.

### Configuração de ambiente

`COLLAB_HOST`, `COLLAB_PORT`, `COLLAB_DB_PATH` (default `./data/collab-mcp.sqlite`, ignorado pelo Git), `COLLAB_LOG_LEVEL`, `COLLAB_WORKSPACES_FILE` (default `./workspaces.json`), além de `COLLAB_ALLOWED_HOSTS`, `COLLAB_TRUST_PROXY`, `COLLAB_TRUSTED_PROXY_IPS`, `COLLAB_AUTH_MAX_FAILURES`, `COLLAB_AUTH_WINDOW_MS`, `COLLAB_AUTH_BLOCK_MS` (detalhes na seção 23). O código lê `process.env`; `.env` nunca é versionado. Opcional nativo: `node --env-file=.env dist/index.js`.

### Configuração de workspaces

Formato (rodada 3: `allowedPrincipals`):

```json
{
  "workspaces": [
    {
      "id": "migracao-2026",
      "name": "Migração 2026",
      "rootPath": "../sistema-legado",
      "allowedPrincipals": [
        "prin_2f1c...",
        "prin_9ab4..."
      ]
    }
  ]
}
```

`workspaces.example.json` traz um placeholder **válido no formato** `prin_00000000-0000-0000-0000-000000000000` (sem segredos e sem root real). Copiar o exemplo sem editar mantém o workspace fail-closed, mas o startup não quebra por formato.

Regras:

- `id` é opaco (sem `/`, `\`, `..`, espaços ou caminho); é o valor usado em `collab_create_room`.
- `rootPath` pode ser absoluto ou relativo ao diretório do JSON; precisa existir e ser diretório real; symlinks/junctions no root são canonicalizados e roots sobrepostos são rejeitados.
- **`allowedPrincipals` é uma lista EXATA de `PrincipalId`** (`prin_<uuid>`), sem wildcard, nomes, displayName ou tokens Bearer. Campo ausente, `null` ou `[]` = **fail-closed**: nenhum principal autorizado (o startup avisa no log, sem tokens/roots).
- IDs são validados no startup contra `isPrincipalIdFormat`; item inválido, não-array ou duplicado derruba o startup (`ConfigError`). **Não** se valida a existência da credencial: ela pode ser emitida depois; `auth:revoke` continua sendo o bloqueio de transporte.
- A lista é **somente configuração do servidor**: nenhuma tool, argumento de modelo, convite ou tabela editável remotamente a altera.
- Política criada UMA vez no startup e compartilhada por todas as sessões MCP; revalidada em TODA chamada de workspace/locking/checkpoint e em create/join/create_invite. `startApplication().revalidateWorkspaces(defs)` (programático, não-tool) ou reiniciar com novo JSON aplica mudanças na próxima chamada, preservando dados.
- O catálogo é montado no startup; remover um workspace da configuração faz as salas antigas falharem com `NOT_FOUND`; remover um principal da lista faz suas operações falharem com `FORBIDDEN` genérico.
- O arquivo contém caminhos reais do host: mantenha-o fora do workspace compartilhado e no `.gitignore`.
- Sem config, o servidor sobe com catálogo vazio e `collab_create_room` retorna `FORBIDDEN` genérico (fail-closed; não distingue workspace inexistente de não autorizado).

### Descoberta de workspaces (antes da primeira sala)

`collab_list_workspaces` aceita `token` **opcional**: só o Bearer de transporte já basta e o resultado é filtrado por `allowedPrincipals` (somente `id`/`name`). Se um `token` for enviado, ele também é validado. `collab_create_room` executa a autorização **antes** de verificar existência, então workspace inexistente e workspace não autorizado retornam o mesmo `FORBIDDEN` genérico — não há oráculo de enumeração. Sem catálogo, o resultado é lista vazia/`FORBIDDEN`, sem root.

### Como conceder / revogar acesso a um workspace

```powershell
# 1) Descobrir/criar o ID do principal (token exibido UMA vez no create)
npm.cmd run auth:list
npm.cmd run auth:create -- "Nome / Cliente"

# 2) Editar workspaces.json: adicionar/remover o "prin_<uuid>" em allowedPrincipals
#    e reiniciar o servidor (ou chamar revalidateWorkspaces programmatically).
# 3) /health continua público; /mcp exige Bearer e agora tambem exige constar na lista.

# Revogacao IMEDIATA de transporte (independe da lista):
npm.cmd run auth:revoke -- prin_<uuid>
```

Conceder = incluir o ID na lista. Revogar = remover da lista (bloqueia workspace) e/ou `auth:revoke` (bloqueia transporte). Um `sessionToken` vazado continua inútil para outro principal (migration 030). Não há ferramenta remota para essa administração nesta rodada.

### Migrations e ferramentas

Migrations aplicadas na ordem: `1` fundação, `2` colaboração, `10` workspace/versões/checkpoints, `20` locks, `30` transport auth (rodada 2). O health reporta `migrationVersion: 30` e `appliedMigrations: 5` em instalação nova.

**37 tools registradas:**

- 1 diagnóstico: `collab_status`;
- 20 colaboração: `collab_create_room`, `collab_create_invite`, `collab_join_room`, `collab_heartbeat`, `collab_leave`, `collab_room_state`, `collab_transfer_coordinator`, `collab_revoke_invite`, `collab_send_message`, `collab_get_updates`, `collab_request_plan`, `collab_respond_to_request`, `collab_list_requests`, `collab_propose_task`, `collab_assign_task`, `collab_update_task`, `collab_list_tasks`, `collab_submit_handoff`, `collab_review_handoff`, `collab_list_handoffs`;
- 8 workspace: `collab_list_workspaces`, `collab_list_files`, `collab_read_file`, `collab_search_files`, `collab_apply_patch`, `collab_create_file`, `collab_file_history`, `collab_restore_version`;
- 5 locking: `collab_lock_acquire`, `collab_lock_renew`, `collab_lock_release`, `collab_lock_status`, `collab_lock_list`;
- 3 checkpoint: `collab_checkpoint_begin`, `collab_checkpoint_end`, `collab_checkpoint_status`.

### Como iniciar localmente com a fixture

```powershell
cd <caminho-do-checkout>
Copy-Item workspaces.example.json workspaces.json
npm.cmd run auth:create -- "Vinicius / OpenCode"   # guarde o Bearer token E o "prin_<uuid>" exibidos
# EDITE workspaces.json: substitua "prin_00000000-0000-0000-0000-000000000000" pelo id real.
# Sem essa edicao o workspace fica fail-closed e collab_create_room retorna FORBIDDEN.
npm.cmd run dev
```

Configure `Authorization: Bearer <token>` no cliente MCP. O workspace `demo` aponta para `fixtures/demo-workspace`. Alternativa compilada:

```powershell
npm.cmd run build
$env:COLLAB_WORKSPACES_FILE = ".\workspaces.json"
npm.cmd start
```

Endpoint MCP: `http://127.0.0.1:3100/mcp` (ou a porta escolhida). `workspaces.json` é ignorado pelo Git; `workspaces.example.json` é apenas modelo. Para usar outro projeto real, edite apenas o `rootPath` do `workspaces.json` local. O fluxo completo de credenciais está na seção 23.

Verificação opcional (handshake + 37 tools + `collab_status`, sem criar sala nem shell):

```powershell
$env:COLLAB_MCP_URL = "http://127.0.0.1:3100/mcp"
$env:COLLAB_MCP_BEARER = "<BEARER_TOKEN>"
npm.cmd run check:mcp
```

### Testes e cobertura desta rodada

`tests/integration/app.test.ts` cobre composição real, health v30 com `auth.enabled`, 37 tools, catálogo vazio, `COLLAB_WORKSPACES_FILE` (já com `allowedPrincipals`), fail-fast de root inválido e ausência de vazamento de caminhos. Os testes de autenticação da rodada 2 estão em `tests/auth/**` (seção 23); os de autorização por workspace da rodada 3 estão em `tests/auth/workspace-authorization.test.ts` (seção 24).

`tests/integration/multiclient.test.ts` cobre dois/três clientes MCP oficiais em sessões HTTP distintas contra o mesmo SQLite/workspace:

- criação de sala e ingresso por convite em conexões diferentes;
- identidades, papéis e autorização por token;
- plan request, resposta por cursor e isolamento de mensagens diretas;
- leitura do mesmo arquivo do host;
- conflito de lock acionável, escrita negada a terceiro, patch, releitura e hash antigo rejeitado;
- negociação por mensagem, liberação, reaquisição e histórico com autores;
- tarefa/handoff e conclusão;
- checkpoint pausando escrita, transferência de coordinator e encerramento pelo coordinator atual;
- expiração de lock e sessão com relógio injetável;
- reinício com o mesmo DB preservando sala, participantes, tarefas, eventos, versões e arquivo, sem journals pendentes.

`tests/integration/workspaces-config.test.ts` cobre o loader de configuração, entradas inválidas, o exemplo versionado e a validação de `allowedPrincipals` (lista exata, ausente/vazio = fail closed, formatos inválidos/duplicatas).

`tests/adapters/` cobre o parse dos templates JSON/TOML, ausência de tokens hardcoded, inventário de tools, presença do `check:mcp` e o script contra app local real (Bearer, 37 tools, `collab_status`, sem imprimir token).

`tests/integration/smoke.ts` sobe a aplicação integrada em porta efêmera, cria sala, entra com segundo cliente, lê, adquire lock, aplica patch e encerra.

### Revisão de segurança e correções desta rodada

Corrigido:

1. Entrypoint agora usa `startApplication` com migrations `[1,2,10,20]` e `createWorkspaceStack`; não sobe mais “só fundação”.
2. Checkpoint anti-deadlock: coordinator atual encerra; autoridade relida do banco; `sealed_by` e evento na sala de origem.
3. `collab_status` deixou de expor o caminho absoluto do SQLite.
4. Erros inesperados não serializam mensagem crua do filesystem (evita vazar caminho absoluto em `ENOENT`/`EACCES`).
5. Leitura de arquivo e leitura para mutação embrulham erros de FS em erros de domínio genéricos.
6. Nomes reservados do Windows (`CON`, `NUL`, `COM1`, etc.) e caracteres inválidos são rejeitados.
7. Roots de workspace iguais/sobrepostos são rejeitados.
8. Aquisição de lock valida contenção real, symlink/junction e rejeita diretório.
9. Cursor limitado a 19 dígitos (rowid SQLite de 64 bits).
10. `note` e `testResults` de checkpoint têm limites explícitos no serviço, além do Zod.
11. Evento `request.created` inclui o corpo, permitindo que o destinatário veja a solicitação via `get_updates`.
12. Loader de workspaces falha alto quando o arquivo explícito não existe; default ausente mantém catálogo vazio seguro.
13. **[rodada 3]** Autorização por workspace: `allowedPrincipals` fail-closed, validação de `PrincipalId` no startup, checagem em camadas (withActor + serviços + create/join/create_invite), filtragem de `list_workspaces`, convites sem bypass e revalidação em processo. Nenhuma migration nova; nenhuma tabela com allowed lists editável remotamente.
14. **[auditoria rodada 2]** `collab_list_workspaces` passou a aceitar `token` opcional (descoberta antes da sala só com Bearer), mantendo validação quando o token é enviado.
15. **[auditoria rodada 2]** `collab_create_room` autoriza ANTES de checar existência; missing e não autorizado retornam o mesmo `FORBIDDEN` (fim do oráculo de workspaceIds).
16. **[auditoria rodada 2]** Recovery de journal e `fileHistory` direto passaram a revalidar `allowedPrincipals`; `recoverPendingWrites` não processa mais journal de workspace alheio.
17. **[auditoria rodada 2]** `allowedHosts` é normalizado para lowercase (o SDK compara hostname canônico) e `X-Forwarded-For` só vira chave de rate limit se for IP literal; proxy config também é validado/normalizado.
18. **[auditoria rodada 2]** Placeholder de `workspaces.example.json` virou um PrincipalId válido no formato (fail-closed sem edição), e docs de adapters foram corrigidos: HTTP 403 ≠ `FORBIDDEN` de tool.
19. **[auditoria rodada 2]** `zod` atualizado de `3.25.76` para `4.6.7`; typecheck, 200 testes, build e smokes passaram. `npm audit --omit=dev` agora tem 0 vulnerabilidades.

Revisado sem achado crítico:

- consultas SQL são parametrizadas; nenhuma concatenação de input em SQL;
- tokens/convites são persistidos somente como SHA-256 e não aparecem em eventos, auditoria ou respostas de estado;
- rootPath e a lista completa de principals não aparecem em respostas, health, erros de tool ou auditoria (o `collab_status` mostra apenas o próprio `principalId`);
- tools de workspace/locking/checkpoint autenticam em toda chamada, derivam sala/agente/workspace do token e revalidam a autorização do principal;
- não há shell arbitrário, CORS liberado ou tool de execução de comandos;
- nenhuma tool aceita `allowedPrincipals`, root ou identidade de principal como argumento.

### Dependências (npm audit)

Auditoria final: `zod` foi atualizado **isoladamente** de `3.25.76` para `4.6.7` (compatível com o peer do SDK e com `zod/v4`); typecheck, 200 testes, build e smokes passaram. `npm audit --json` retornou, nesta execução, **3 advisories, todos dev**: 2 critical e 1 moderate, na cadeia Vitest/Vite (`tinypool`, `@vitest/mocker`, `vitest`). O advisory database do npm pode mudar com o tempo; o valor verificável é o comando executado na publicação. **`npm audit --omit=dev` retorna 0 vulnerabilidades.** Nenhum `npm audit fix --force` ou atualização em massa foi executado; o major do Vitest (5.x) fica para uma rodada própria.

### Limitações restantes

- **[RESOLVIDO na rodada 2]** Autenticação de transporte HTTP implementada. **[RESOLVIDO na rodada 3]** Autorização por workspace implementada; restam **autorização por sala** e **administração remota de `allowedPrincipals`** (hoje só via edição de `workspaces.json` + restart/revalidação). Ver seções 23 e 24.
- **Modo cooperativo**: ferramentas nativas de escrita/shell podem ignorar locks, checkpoints, hashes e a autorização por workspace.
- Sem canal de mensagem entre salas diferentes; conflito de lock entre salas é visível, mas a negociação depende de canal externo.
- Adapters são templates/runbooks; **nenhuma conexão real de OpenCode, Codex, Claude Code ou Tailscale foi validada**. `check:mcp` foi validado contra app local efêmera.
- `pathKey` é case-folded no Windows; diferenças Unicode de casing e hard links não são tratados como bypass (hard link exige acesso local ao filesystem).
- Não há delete, rename/move nem criação de diretórios; o diretório pai precisa existir.
- Handoff não preenche automaticamente locks liberados/retidos.
- Não há failover automático de coordinator; transferir para participante sem sessão ativa pode deixar a sala sem coordinator operacional.
- Sem bridge stdio, adapters por cliente, modo estrito ou operações Git.
- Um único processo deve abrir o SQLite; múltiplos processos no mesmo DB não são suportados.
- Rate limiting de transporte existe, mas é em memória e por processo (sem estado compartilhado); aceitável apenas no loopback local.

### Próximos passos obrigatórios

1. **[CONCLUÍDO na rodada 2]** Autenticação de transporte HTTP, identidade por credencial e revogação.
2. **[CONCLUÍDO na rodada 3]** Autorização de transporte por workspace (`allowedPrincipals`).
3. **Próximo** Autorização por sala, administração remota de `allowedPrincipals` e acesso privado remoto (Tailscale Serve) — **ainda não configurado**.
4. **[Templates prontos]** Adapters/instruções para OpenCode, Codex, Claude Code, genérico e Tailscale; falta executar a conexão real de cada cliente e revisar flags/versões no host.
5. Piloto real OpenCode + Codex em workspace de migração.
6. Claude Code na mesma sala sem alterar o núcleo.
7. Bridge stdio com paridade funcional.
8. Avaliação de modo estrito e atualização major do Vitest (advisories dev).

## 23. Autenticação de transporte — registro histórico da rodada 2

### Decisão de auth

Bearer **estático por principal**, sem OAuth. Uma credencial por pessoa/cliente/instalação (não por sala). Token `collab_p_` + 32 bytes aleatórios (base64url, 256 bits); o servidor persiste **somente `sha256(token)`** (hex, UNIQUE). Não há cache de credenciais: toda requisição consulta o SQLite, portanto `auth:revoke` bloqueia **na próxima requisição**. `startApplication`/entrypoint exigem auth **sempre**; `startServer` também exige por padrão, e `transportAuth: { mode: "disabled-for-tests" }` é uma opção tipada explícita usada apenas pelos testes da fundação.

### Migration 030 (v20 → v30)

`src/persistence/migrations/030_transport_auth.ts`:

- `transport_principals(id, name, token_hash UNIQUE, status active|revoked, created_at, revoked_at)`;
- `ALTER TABLE collab_sessions ADD COLUMN principal_id TEXT` **condicional** (consulta `sqlite_master`/`PRAGMA table_info`), para funcionar também em bancos sem colaboração;
- índice `collab_sessions_principal_idx`.

Migrations anteriores intactas. Ordem em instalação nova: `[1, 2, 10, 20, 30]`; health reporta `migrationVersion: 30`, `appliedMigrations: 5`. Sessões de sala legadas ficam com `principal_id = NULL`: dados preservados, mas inacessíveis via transporte autenticado (não há como provar o dono). Coberto por teste de upgrade v20 → v30.

### CLI e formato de configuração

```powershell
npm.cmd run auth:create -- "Vinicius / OpenCode"   # imprime id, name e o token UMA vez
npm.cmd run auth:list                              # id | status | createdAt | name (sem token/hash)
npm.cmd run auth:revoke -- prin_<uuid>            # status=revoked, sem token
```

`src/cli/auth.ts` abre o mesmo `COLLAB_DB_PATH`, aplica as migrations de forma idempotente e fecha a conexão (transação curta; `busy_timeout` configurado). Recomenda-se servidor parado; escritas administrativas curtas com o servidor ativo são suportadas pelo lock de arquivo do SQLite. Compilado: `node dist/cli/auth.js <comando>`.

Variáveis novas em `src/config/env.ts` (`.env.example` documenta todas, sem segredos):

| Variável | Default | Papel |
|---|---|---|
| `COLLAB_ALLOWED_HOSTS` | `127.0.0.1,localhost,[::1]` | Host headers aceitos, separados por vírgula, **sem wildcard**; passados a `createMcpExpressApp({ allowedHosts })` |
| `COLLAB_TRUST_PROXY` | `0` | Habilita confiança em `X-Forwarded-For` |
| `COLLAB_TRUSTED_PROXY_IPS` | `127.0.0.1,::1` (após normalizar `::ffff:...`) | Pares remotos autorizados a fornecer o header; cada item precisa ser IP literal |
| `COLLAB_AUTH_MAX_FAILURES` | `5` | Falhas Bearer inválidas por janela |
| `COLLAB_AUTH_WINDOW_MS` | `60000` | Janela deslizante |
| `COLLAB_AUTH_BLOCK_MS` | `60000` | Duração do bloqueio (429 + `Retry-After`) |

**Binding continua SOMENTE loopback** (`COLLAB_HOST` rejeita qualquer outro valor). Para Tailscale Serve, adicione apenas o hostname explícito do proxy a `COLLAB_ALLOWED_HOSTS` e habilite `COLLAB_TRUST_PROXY` se o proxy encaminhar IP; o listener permanece em loopback. Nenhum proxy custom foi implementado.

### Como o principal chega ao ToolContext

Pesquisa no SDK 1.32.2: `StreamableHTTPServerTransport.handleRequest` lê `req.auth` e o repassa como `authInfo` em `RequestHandlerExtra` (`webStandardStreamableHttp.js` → `onmessage(message, { authInfo })`). Propagação em três camadas, sem rewrites no SDK:

1. **Middleware** `createTransportAuthMiddleware` (`src/server/auth/transportAuth.ts`), aplicado via `app.use("/mcp", mw)`: valida `Authorization: Bearer` em POST/GET/DELETE, seta `req.auth` no shape `AuthInfo` com **token redigido**, e executa `runWithPrincipal(principal, () => next())` (AsyncLocalStorage, `src/server/auth/principalContext.ts`).
2. **Autoridade primária**: `httpApp` congela o principal validado no handshake dentro do `ToolContext` **daquela sessão MCP** (`createMcpServer(context, principal, modules)`). Independente de async context, robusto para POST/GET/DELETE/SSE e para sessões concorrentes. `httpApp` também guarda `sessionId → principalId` e devolve **403** se outra credencial tentar reusar a sessão.
3. `ToolContext.authenticatedPrincipal` e `ToolContext.authEnabled` são lidos pelos `ToolModule`s; **nenhuma tool aceita identidade de argumentos do modelo**.

Respostas HTTP: **401** corpo único `{"error":"unauthorized"}` + `WWW-Authenticate: Bearer` (header ausente, formato inválido, token inexistente ou revogado — sem distinguir); **403** só com identidade válida sem autorização sobre a sessão; **429** para excesso de tentativas inválidas; `/health` público.

### Adaptações em collaboration / workspace / locking

- `contracts`: `PrincipalId`, `AuthenticatedPrincipal`, `PrincipalView`, `TransportAuthMode` (`principal.ts`).
- `collaboration/auth.ts`: `AuthenticateCollaborationOptions.principalId` **obrigatório**; query lê `s.principal_id` e rejeita divergência/NULL com `FORBIDDEN`.
- `collaboration/types.ts`: `CreateRoomCommand` / `JoinRoomCommand` (internos, com `principalId`); a API pública `CreateRoomInput`/`JoinRoomInput` continua sem identidade.
- `rooms.ts`: `createRoom` e `joinRoom` gravam `principal_id` na sessão (migration 030).
- `service.ts`: `CollaborationServiceOptions.principalId` obrigatório, injetado em `authenticate`, `createRoom`, `joinRoom`, `heartbeat` e `leave`.
- `workspace/runtime.ts`: `WorkspaceRuntime.principalId`; `toolSupport.withActor` repassa ao autenticar. `stack.ts` deriva tudo de `context.authenticatedPrincipal.id`.
- `collaborationToolModule` aceita `principalId?` apenas para composição manual; em produção usa o contexto.
- `collab_status`: `authEnabled`, `principalId`, `principalName`; health: `auth.enabled`. Nenhum token/hash/root.
- Testes diretos de serviço injetam `TEST_PRINCIPAL.id` explicitamente (fixtures), nunca header/env mágico.

**Distinção**: `auth:revoke` bloqueia o **transporte**; `collab_leave` revoga a **sessão de sala**. Um principal pode criar/entrar em várias salas; o `sessionToken` continua controlando o ator dentro de cada sala.

### Testes e totais desta rodada

`npm.cmd run typecheck`, `npm.cmd test`, `npm.cmd run build`, `npm.cmd run smoke` e start real do `dist/` com credencial emitida pelo CLI: **todos OK** na época. Suíte histórica: **165 testes / 21 arquivos**; o total final desta rodada está na seção 25.

Novos em `tests/auth/`:

- `transport.test.ts` — 401 idêntico para 6 casos, 200 com credencial válida (37 tools + `create_room`), revogação imediata, 403 por reuso de sessão MCP, 401 em POST/GET/DELETE com `/health` público, Host loopback/desconhecido/allowed configurado, rate limiting (não afeta token válido, libera com o tempo, sweep unitário, não loga token), e não vazamento de token/hash em DB/health/audit/respostas/logs; migration 030 condicional em banco sem colaboração.
- `binding.test.ts` — `create_room`/`join` gravam o `principal_id` correto; principal B não usa `sessionToken` de A em 7 tools (`FORBIDDEN`); um principal em várias salas; revogação preserva dados e `collab_leave` continua o mecanismo de sala.
- `principals.test.ts` — store (somente hash, revogação idempotente), CLI create/list/revoke (token só no create), upgrade v20 → v30 preservando sala/agente/participante/sessão e negando sessão legada.

Adaptados: helpers de cliente MCP (`requestInit.headers.Authorization`), fixtures de integração (3 Bearer tokens distintos), `app.test.ts`, `multiclient.test.ts`, `smoke.ts`, testes de módulo via HTTP e expectativas de migration v30.

### Como gerar a primeira credencial

```powershell
cd <caminho-do-checkout>
npm.cmd run auth:create -- "Nome / Cliente"
# copie o token collab_p_... exibido (uma unica vez) para o cliente MCP:
#   Authorization: Bearer collab_p_...
npm.cmd run dev
```

Sem nenhum principal ativo, o entrypoint avisa no log; `/mcp` retorna 401 e `/health` continua 200.

### O que ainda falta para Tailscale / Codex (NAO declarar pronto)

- **[RESOLVIDO na rodada 3]** Autorização de transporte por workspace (`allowedPrincipals`). Resta **autorização por sala** e **administração remota da lista** (hoje só editando `workspaces.json` + restart/revalidação). Ver seção 24.
- Configurar Tailscale Serve (reverse proxy → loopback) e revisar `COLLAB_ALLOWED_HOSTS` + `COLLAB_TRUST_PROXY`/`COLLAB_TRUSTED_PROXY_IPS` para o hostname/IP reais; **não configurado nesta etapa**.
- Adaptadores/instruções por cliente existem como templates em `adapters/**`; falta validar a conexão real (OpenCode, Codex, Claude Code) com endpoint + Bearer **e `allowedPrincipals` concedido**.
- Bridge stdio com paridade funcional, modo estrito e piloto real.
- Advisories dev do Vitest/Vite (major 5.x) — zod já corrigido em 4.6.7; nenhum `npm audit fix --force` foi executado.

### Limitações e riscos residuais

- Modo **cooperativo**: ferramentas nativas de escrita/shell podem ignorar locks, checkpoints e hashes; o MCP só protege o que passa por ele.
- Rate limiting em memória, por processo e por endereço do par; sem estado compartilhado.
- CLI e servidor podem abrir o mesmo SQLite em processos distintos (recomenda-se servidor parado para operações administrativas).
- Sessões de sala pré-v30 ficam inutilizáveis (dados preservados); exigem nova sala/novo convite.
- `/health` é público (sem segredos) e continua sem rate limiting.
- `collab_status` revela `principalId`/`principalName` ao próprio portador autenticado (dados considerados seguros); a lista completa de principals nunca é exposta.
- Papéis continuam sendo da sala; a autorização de transporte é por workspace, não por sala/role.
- Acesso remoto **não** está pronto: binding externo, Tailscale e porta pública permanecem desabilitados.

---

**Resumo operacional:** um servidor MCP neutro e privado coordena vários agentes em um único workspace. Sessões ativas trocam solicitações e mensagens; o coordinator distribui trabalho; arquivos diferentes podem avançar em paralelo; o mesmo arquivo exige lock e negociação; toda gravação mediada pelo servidor valida posse e versão; testes e commits ocorrem em checkpoints estáveis. A autenticação de transporte Bearer por principal, a revogação, o vínculo com as sessões de sala e a **autorização por workspace (`allowedPrincipals`, fail-closed)** estão implementados e testados localmente; o piloto remoto ainda depende de autorização por sala, administração remota da lista, adaptação dos clientes e acesso privado (Tailscale), que **não** foram configurados.

## 24. Autorização por workspace — registro da rodada 3

### Decisão e formato

`workspaces.json` (ou `definitions` injetadas em `startApplication`) ganhou `allowedPrincipals: ["prin_<uuid>", ...]`: lista **EXATA** de IDs de principal, sem wildcard, nomes, displayName ou tokens Bearer. **Fail-closed**: campo ausente, `null` ou `[]` => nenhum principal autorizado (o startup registra aviso sem tokens/roots). IDs são validados no startup por `isPrincipalIdFormat` (`src/contracts/principal.ts`); item inválido, não-array ou duplicado => `ConfigError` e o servidor não sobe. Não se valida a existência da credencial (pode ser emitida depois); `auth:revoke` continua bloqueando o transporte na próxima requisição.

`workspaces.example.json` usa placeholder válido no formato `prin_00000000-0000-0000-0000-000000000000` (sem segredos, sem root real); sem edição o workspace fica fail-closed. `workspaces.json` real continua no `.gitignore`.

### Sem migration nova

A política (`src/workspace/authorization.ts`) é construída UMA vez em `startApplication`, **compartilhada** por todas as sessões MCP e mantida em memória. Motivo: `allowedPrincipals` é configuração do servidor; colocá-la em tabela abriria superfície de edição remota. `ws_catalog` (migration v10) continua sendo apenas espelho durável de roots. Migration 030 intacta; **v40 reservada e não utilizada**; health segue `migrationVersion: 30` / `appliedMigrations: 5`. `WorkspaceAuthorization.replace()` / `RunningApplication.revalidateWorkspaces(defs)` revalidam em processo (equivalente a reiniciar com novo JSON), validando tudo de novo antes de trocar o estado. Não é uma tool MCP.

### Pontos exatos de checagem

| Camada | Onde | O que faz |
|---|---|---|
| Transporte | middleware Bearer (rodada 2) | 401 para token ausente/inerte/revogado; 403 para sessão MCP de outro principal |
| Politica | `WorkspaceAuthorization.isAllowed/assertAllowed` | lista exata, fail-closed; erro `FORBIDDEN` generico sem enumerar principals/workspaces |
| Tools workspace/locking/checkpoint | `withActor` → `resolveAuthorizedRoot` (16 tools) | revalida `runtime.principalId` sobre `actor.room.workspaceId` em TODA chamada |
| Servicos | `files.requireAuthorizedWorkspace`, `locks` (acquire/renew/release/status/list/assertUsableLock), `checkpoints` (begin/end/status), `mutations.performMutation` | defesa em camadas mesmo em chamada direta de servico |
| Colaboracao | `WorkspaceDirectory.principalCanAccess` em `createRoom`, `joinRoom`, `createInvite` | create/join exigem principal listado; convite nao amplia acesso; join nega ANTES de criar agente/sessao ou consumir convite (rollback) |
| Listagem | `collab_list_workspaces` → `listSafeForPrincipal` | retorna somente id/name dos workspaces autorizados ao principal |

`WorkspaceDirectory.principalCanAccess` é **obrigatório**; `create_room`/`join_room`/`create_invite` negam (fail-closed) se ele estiver ausente. O helper estático de testes devolve `true` explicitamente e nunca é usado em produção. `collab_status` mostra apenas o próprio `principalId`/`principalName`.

### Comportamento apos perda de acesso

- `create_room` / `join_room` / `create_invite`: `FORBIDDEN` generico para principal removido; convite valido nao e consumido e nao serve de bypass.
- `list_workspaces`: filtrado; nao vaza workspaces/principals nao autorizados.
- `read_file`, `list_files`, `search_files`, `apply_patch`, `create_file`, `restore_version`, `file_history`, `lock_*`, `checkpoint_*`: `FORBIDDEN` na PROXIMA chamada, sem apagar salas, sessoes, versoes, historico ou journals.
- `collab_heartbeat`, `collab_leave`, `collab_room_state` e demais tools de sala: **continuam** operando pela sessao autorizada (decisao documentada: nao leem arquivos e permitem encerrar/renovar a propria sala com seguranca).
- `auth:revoke`: bloqueia o transporte (401) independentemente da lista.

### Conceder / revogar

Conceder = `auth:create` (obter `prin_<uuid>`) + incluir o ID em `allowedPrincipals` do workspace + reiniciar (ou `revalidateWorkspaces`). Revogar acesso ao workspace = remover o ID da lista + reiniciar/revalidar. Revogar credencial = `npm.cmd run auth:revoke -- prin_<uuid>` (401 imediato). Nao ha tool/administrador remoto para essa lista nesta rodada.

### Testes e totais desta rodada

Na época desta rodada: `npm.cmd run typecheck`, `npm.cmd test` (**179 testes / 22 arquivos**), `npm.cmd run build`, `npm.cmd run smoke` e start real do `dist/` com credencial emitida pelo CLI e `workspaces.json` com `allowedPrincipals`: **todos OK**. O total final auditado é **200 testes / 24 arquivos** (seção 25).

Novos em `tests/auth/workspace-authorization.test.ts` (15 testes, aplicacao real + 2/3 clientes MCP oficiais; inclui descoberta antes da sala e não-oráculo de `create_room`):

- dois principals autorizados no mesmo workspace colaboram (create/join/read/lock/patch/history e2e);
- A autorizado, B nao: `create_room` negado; convite de A nao permite B entrar (e NAO consome o convite: C ainda ingressa); `list_workspaces` filtrado;
- B com sessao legitima em outro workspace nao alcanca arquivos/locks/checkpoint do primeiro (workspace vem da sala; checkpoint de ws_b nao pausa ws_a);
- remocao por `revalidateWorkspaces` bloqueia read/list/search/history/locks/apply_patch/create_file/restore/checkpoints na proxima chamada e preserva dados; heartbeat/leave/room_state continuam; coordinator que perde acesso nao emite convites;
- `auth:revoke` continua 401; campo ausente/`[]` = fail closed (com aviso de log); config invalida/duplicada/nao-array falha alto no loader e no `startApplication`;
- restart com o MESMO DB e nova config preserva sala/versoes/arquivo (sem migration nova, v30 intacto) e nega o principal removido;
- nenhuma resposta/erro vaza lista de principals, `rootPath` ou roots do host.

Adaptado em `tests/integration/workspaces-config.test.ts` (1 teste novo: lista exata, ausente/vazio, invalidos/duplicatas). Atualizados: fixtures de integracao (credenciais pre-criadas antes do startup para constarem em `allowedPrincipals`), `app.test.ts`, `multiclient.test.ts`, `smoke.ts` e `tests/auth/helpers.ts`.

### Riscos e limitacoes residuais desta rodada

- **Modo cooperativo** continua: ferramentas nativas de escrita/shell podem ignorar locks, checkpoints, hashes E a autorizacao por workspace (so protegemos o que passa pelo MCP).
- Autorizacao e **por workspace**, nao por sala: todos os principals listados podem criar/entrar em qualquer sala daquele workspace (respeitando convites e papeis da sala).
- Nao ha administracao remota da lista: conceder/revogar exige editar `workspaces.json` no host + restart/revalidacao. `revalidateWorkspaces` e API programatica, nao tool MCP.
- A politica e em memoria e por processo; reiniciar sempre relê a config. Um principal com `sessionToken` valido mas removido da lista perde acesso a arquivos, mas continua podendo usar heartbeat/leave/room_state (decisao explicita).
- `collab_status` e logs locais podem citar o `principalId` do proprio portador (ID, nao token); a lista completa nunca aparece.
- **Acesso remoto NAO esta pronto**: binding segue loopback; Tailscale não configurado; adapters são templates; bridge stdio e modo estrito não existem. Antes de habilitar, revisar `allowedHosts`, proxy confiável e a granularidade por sala.

## 25. Rodada 2 — auditoria independente, adapters e fechamento

### Estado final

- **200 testes / 24 arquivos** passando (typecheck e build OK).
- 37 tools, migrations `[1, 2, 10, 20, 30]`, health em v30/5 migrations.
- `zod` em `4.6.7`; `npm audit --omit=dev` = **0 vulnerabilidades**. Nesta execução restam 3 advisories dev (2 critical, 1 moderate; Vitest/Vite), sem upgrade major nesta rodada.
- Autenticação Bearer, revogação, vínculo principal↔sessão, `allowedPrincipals` fail-closed e descoberta de workspace só com Bearer estão implementados e testados.
- **Adapters/templates** para OpenCode, Codex/ChatGPT desktop, Claude Code, MCP genérico e Tailscale; `check:mcp` validado contra app local efêmera. **Nenhum cliente real nem Tailscale foi conectado/validado.**

### Achados da auditoria e correções

Severidade alta/real (corrigidos):

1. **Descoberta de workspace bloqueada antes da primeira sala** — `collab_list_workspaces` exigia sessão de sala. Agora `token` é opcional; a tool usa o principal autenticado pelo Bearer, filtra `allowedPrincipals` e retorna somente `id`/`name`. Token enviado continua validado.
2. **Oráculo de existência em `create_room`** — workspace inexistente retornava `NOT_FOUND` enquanto workspace existente não autorizado retornava `FORBIDDEN`. A autorização agora ocorre antes da checagem de existência; ambos retornam o mesmo `FORBIDDEN` genérico.
3. **Recovery de journal disparado por principal não autorizado** — abrir uma sessão MCP podia processar journal de workspace alheio. `recoverPendingWrites` agora exige `principalCanAccess` do runtime.
4. **`fileHistory` direto sem autorização de principal** — o serviço revalidava apenas catálogo/root; agora usa `resolveAuthorizedRoot` com o principal do runtime.
5. **Allowed host com caixa alta** — config aceitava, mas o SDK compara hostname lowercase; entradas agora são canonicalizadas para lowercase. Teste de configuração adicionado.
6. **`X-Forwarded-For` arbitrário como chave de rate limit** — agora só IP literal (`net.isIP`), com fallback ao par remoto; IPs de proxy normalizados na config. Header inválido não vira chave arbitrária.
7. **Placeholder inválido no `workspaces.example.json`** — `prin_COLE_AQUI...` não passava no validador e quebrava o startup ao copiar o exemplo. Trocado por UUID de placeholder válido; fail-closed sem edição.
8. **Docs de adapter confundiam HTTP 403 com `FORBIDDEN`** — 403 é apenas sessão MCP de outro principal; negação de workspace/papel é resultado de tool `isError`/`FORBIDDEN` (HTTP 200). Corrigido em READMEs/snippets/protocolo.

Severidade média/baixa e revisão:

- Auth parsing cobre case-insensitive/whitespace; duplicatas e dois tokens são rejeitados; testes unitários adicionados.
- CORS continua inexistente; `/health` é público sem segredos; OPTIONS não libera origem.
- Sessão MCP é vinculada ao principal; GET/DELETE/POST com Bearer de outro principal retornam 403.
- Tokens/convites continuam somente como SHA-256; DB/health/audit/logs sem texto puro; teste de bytes do SQLite cobre.
- SQL permanece parametrizado; nenhuma concatenação de input em query.
- Recovery, hash/lock/checkpoint e validação de path já tinham cobertura; receberam regressões adicionais.
- Nenhuma tool aceita root, `allowedPrincipals` ou identidade de principal como argumento.
- `check:mcp` não cria sala, não executa shell e não imprime token; a URL também é redigida na saída.
- `RunningApplication` não expõe mais a política interna com `entries()`/roots; permanecem apenas `workspaceIds`, `workspaceCount` e `revalidateWorkspaces`.

### Adapters e protocolo compartilhado

Arquivos: `adapters/opencode/{opencode.json,README,AGENTS.snippet}`, `adapters/codex/{config.toml,README,AGENTS.snippet}`, `adapters/claude-code/{mcp.json.example,README,CLAUDE.snippet}`, `adapters/generic-mcp`, `adapters/tailscale`, `adapters/shared/{AGENT_PROTOCOL,TOOL_REFERENCE}` e `adapters/scripts/check-mcp-connection.ts`.

Validação factual contra documentação oficial atual:

- OpenCode V2: `mcp.servers`, `type:remote`, `oauth:false`, `codemode:false`, `protocol:legacy`, headers `{env:...}` — confirmado na doc oficial;
- Codex: `[mcp_servers.<name>]`, `url`, `bearer_token_env_var`, `startup_timeout_sec`, `tool_timeout_sec`, `enabled`, CLI `--bearer-token-env-var` — confirmado;
- Claude Code: `.mcp.json` `type:http`, `headers` com `${VAR}`, `claude mcp add/add-json` — confirmado;
- Tailscale Serve: `tailscale serve --bg 3100`, `status`, `reset`, proxy preferencialmente `http://127.0.0.1`, sem Funnel/port forwarding — confirmado; acesso real não configurado.

Protocolo compartilhado cobre create/join, heartbeat, polling por cursor, locks, patch/hash, negociação, checkpoint, handoff, modo cooperativo e os dois segredos (Bearer × sessionToken). A ordem foi corrigida para `collab_list_workspaces` antes da primeira sala. Não há instrução para contornar locks/hashes/checkpoint.

### Tailscale e conexão real — NÃO validado

O runbook descreve Tailscale Serve privado (sem Funnel), `COLLAB_ALLOWED_HOSTS` explícito e `COLLAB_TRUST_PROXY` opcional. **Nada disso foi executado neste host**: Tailscale não está instalado/configurado, firewall/ACL não foram alterados e nenhum cliente real foi conectado. Não declarar o piloto remoto pronto.

### Riscos residuais

- Modo cooperativo: ferramentas nativas podem ignorar MCP, locks, hashes, checkpoints e autorização por workspace.
- Rate limiting em memória/por processo; token válido limpa o histórico da chave. Atrás de proxy, a granularidade depende de `TRUST_PROXY`/XFF sanitizado.
- CLI e servidor podem abrir o mesmo SQLite em processos distintos; recomendação de servidor parado para administração.
- Sem autorização por sala/role no transporte; `allowedPrincipals` é por workspace.
- Sem administração remota de `allowedPrincipals`; concessão/revogação exige editar `workspaces.json` e reiniciar/revalidar.
- `collab_heartbeat`/`leave`/`room_state` e demais tools de sala continuam após perda de acesso ao workspace (não leem arquivos); decisão documentada.
- Open SSE de principal revogado pode permanecer até fechar; novas requisições já recebem 401.
- Adapters não foram testados contra os binários reais nem contra Tailscale.

### Próximo passo recomendado

1. Conectar um cliente real (OpenCode ou Codex) em loopback com Bearer e workspace fixture, usando `check:mcp` como baseline já validado.
2. Configurar Tailscale Serve em ambiente controlado e validar `allowedHosts`/proxy/ACL com dois PCs.
3. Só então executar o piloto OpenCode + Codex; Claude Code e bridge stdio depois.
4. Tratar autorização por sala e administração de `allowedPrincipals` antes de uso multiempresa.
5. Planejar upgrade major do Vitest (advisories dev) separadamente.

## 26. Publicação pública — Agent Live Share

### Nome, repositório e licença

- **Nome público:** Agent Live Share.
- **Codename interno:** Collab MCP (mantido em `AGENTS.md`, `CLAUDE.md`, comentários e nomes históricos de módulos).
- **Repositório público:** `https://github.com/viniciusadami-ux/agent-live-share` (visibilidade pública).
- **Licença:** MIT, copyright 2026 Vinicius Adami Cabral (`LICENSE`).
- **Pacote:** `agent-live-share`, `private: true`; não é publicado no npm.
- **Branch principal esperada:** `main`.

### Arquivos de publicação

- `README.md` público em português, com arquitetura Mermaid, quickstart testado, clientes, segurança e limitações.
- `LICENSE`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`.
- `.editorconfig`, `.gitattributes`, `.gitignore` revisado para segredos/roots/artefatos.
- `.github/workflows/ci.yml`: Windows `windows-latest`, Node 22.x/24.x, `npm ci`, typecheck, tests, build e auditoria de produção informativa.
- `.github/dependabot.yml` semanal para npm e GitHub Actions.
- `.github/ISSUE_TEMPLATE/{bug_report,feature_request,config}.yml`, `.github/pull_request_template.md` e `.github/CODEOWNERS`.
- `workspaces.example.json` usa apenas a fixture local `fixtures/demo-workspace` e placeholder de principal; nunca um root real.

### Decisões de apresentação

- O README é o entrypoint público; `AGENTS.md`/`CLAUDE.md` continuam como documentação profunda de engenharia.
- Badges apontam para `viniciusadami-ux/agent-live-share` (CI em `main`, licença MIT, Node >=22.5, MCP).
- O tom é técnico e honesto: não há screenshots, benchmarks, usuários fictícios ou promessa de cliente remoto/Tailscale validado.
- O produto continua em modo cooperativo local; a publicação pública não muda o escopo nem a segurança do runtime.

### Estado da árvore antes da publicação

- 200 testes / 24 arquivos; typecheck, build, smokes e start compilado com fixture/Bearer validados.
- Migrations v30; 37 tools.
- `npm audit --omit=dev` = 0 vulnerabilidades.
- Nenhum cliente real/Tailscale validado.
- A árvore **não** contém `.git`; a inicialização/commit/push é responsabilidade do orquestrador, não deste agente.
