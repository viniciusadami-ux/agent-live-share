# Adapters de clientes — Collab MCP

Esta pasta reúne **documentação, templates de configuração e um script de verificação** para clientes MCP. Nada aqui é um novo servidor, bridge ou implementação paralela: o Collab MCP continua sendo o único núcleo.

> **Status desta entrega:** templates/documentação + `check:mcp`. O script foi validado contra uma aplicação local efêmera com Bearer e 37 tools, mas **nenhuma conexão real de OpenCode, Codex/ChatGPT desktop, Claude Code, Tailscale ou outro cliente foi executada/validada neste ambiente**. Os arquivos abaixo são template e runbook, não uma prova de conexão do cliente.

## Conteúdo

| Caminho | O que é |
|---|---|
| `shared/AGENT_PROTOCOL.md` | Protocolo operacional obrigatório para qualquer agente (regras, ordem, heartbeat, locks, patches, checkpoints, erros). |
| `shared/TOOL_REFERENCE.md` | Inventário real das 37 tools, campos e retornos. |
| `opencode/` | Template OpenCode V2 (`mcp.servers`), README e snippet de `AGENTS.md` do projeto compartilhado. |
| `codex/` | Template `config.toml` (`bearer_token_env_var`), README para ChatGPT desktop/Codex CLI e snippet de `AGENTS.md`. |
| `claude-code/` | Template `.mcp.json`, README com `claude mcp add`/`add-json` e snippet de `CLAUDE.md`. |
| `generic-mcp/` | Requisitos mínimos para qualquer cliente MCP Streamable HTTP; bridge stdio apenas como futuro. |
| `tailscale/` | Runbook verificável de acesso remoto privado via Tailscale Serve; não executado. |
| `scripts/check-mcp-connection.ts` | Verificação opcional: conecta com o cliente MCP oficial, lista tools e chama `collab_status`, sem imprimir o token. |

## Matriz de clientes

| Cliente | Configuração | Endpoint local | Endpoint remoto futuro | Status |
|---|---|---|---|---|
| OpenCode V2 | `opencode.json` → `mcp.servers.collab` | `http://127.0.0.1:3100/mcp` | `https://HOST.TAILNET.ts.net/mcp` | Template/documentação |
| Codex/ChatGPT desktop | `config.toml` → `[mcp_servers.collab]` | `http://127.0.0.1:3100/mcp` | `https://HOST.TAILNET.ts.net/mcp` | Template/documentação |
| Claude Code | `.mcp.json` → `mcpServers.collab` | `http://127.0.0.1:3100/mcp` | `https://HOST.TAILNET.ts.net/mcp` | Template/documentação |
| Cliente MCP genérico | Streamable HTTP + Bearer | conforme cliente | conforme cliente | Requisitos |
| Tailscale | `tailscale serve` | não se aplica | tailnet | Runbook, não configurado |

## Como o amigo conecta **hoje** (loopback)

Hoje o servidor escuta apenas `127.0.0.1`. Portanto:

- O amigo **não** consegue alcançar o loopback do host de outro PC.
- Para um teste local, o amigo/cliente precisa estar no **mesmo host** do servidor.
- O amigo usa um **Bearer próprio** (não o do dono), e o `prin_...` dele deve estar em `allowedPrincipals` do workspace. Um convite é necessário para entrar na sala, mas **não substitui** a lista de principals.
- **Descoberta antes da primeira sala:** `collab_list_workspaces` pode ser chamado só com o Bearer (o `token` de sessão é opcional). Ele retorna apenas `id`/`name` autorizados ao principal. O `workspaceId` continua sendo operacional, nunca um caminho.
- O coordinator (dono) cria a sala com o `workspaceId` autorizado; o amigo entra com o convite.

Passo a passo local (mesmo host):

1. No host, crie um principal para cada pessoa/cliente:
   ```powershell
   npm.cmd run auth:create -- "Dono / OpenCode"
   npm.cmd run auth:create -- "Amigo / Codex"
   ```
   Guarde cada Bearer no cliente correspondente; nunca compartilhe o do dono com o amigo.
2. Adicione os dois `prin_...` em `allowedPrincipals` do workspace no `workspaces.json` do host e reinicie/revalide o servidor.
3. Configure o cliente do dono com o Bearer do dono, chame `collab_list_workspaces` (sem token de sala) e escolha o `workspaceId` autorizado.
4. Crie a sala (`collab_create_room`) usando esse `workspaceId`; crie um convite (`collab_create_invite`) e entregue o `inviteToken` ao amigo por canal privado (fora do MCP/arquivos do workspace).
5. Configure o cliente do amigo no mesmo host com o Bearer do amigo e entre com `collab_join_room`.
6. Confirme com `collab_room_state` em ambos; use `collab_get_updates` para acompanhar.

## O que muda com Tailscale

- O servidor continua em loopback; o Tailscale Serve publica HTTPS no tailnet.
- O cliente usa `https://HOST.TAILNET.ts.net/mcp`.
- `COLLAB_ALLOWED_HOSTS` precisa incluir o hostname explícito do MagicDNS.
- O Bearer continua sendo a autorização de transporte; a ACL do Tailscale restringe quem alcança o host.
- `allowedPrincipals` continua sendo revalidado por workspace.
- Nada disso está configurado nesta máquina; siga `tailscale/README.md` e valide em duas máquinas.

## Verificação opcional

```powershell
$env:COLLAB_MCP_URL = "http://127.0.0.1:3100/mcp"
$env:COLLAB_MCP_BEARER = "<BEARER_TOKEN>"
npm.cmd run check:mcp
```

O script usa o cliente MCP oficial, valida o handshake, lista as tools e chama `collab_status`. Ele não imprime o token e não executa shell genérico. **Ele vive no checkout do Collab MCP e depende das dependências Node desse checkout**; em um cliente sem o repositório, use o status/tool list nativo do cliente (`/mcps`, `codex mcp list`, `claude mcp list`) ou copie o script para um checkout com dependências.

## Regras de segurança para todos os clientes

- Bearer de transporte (`collab_p_`) e token de sessão (`collab_s_`) são segredos distintos.
- Nunca grave tokens em arquivos versionados, no workspace, em mensagens, handoff ou logs.
- `sessionToken` é retornado uma única vez e fica somente em memória; perda de sessão exige novo convite.
- `inviteToken` deve ser entregue por canal privado fora do MCP.
- O modo é cooperativo: ferramentas nativas de edição/shell podem ignorar locks/hashes/checkpoints. O agente deve evitar escritas nativas em arquivos compartilhados.
- Não há bridge stdio, OAuth, push ou modo estrito nesta etapa.
