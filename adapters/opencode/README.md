# OpenCode V2 — Collab MCP

Este diretório contém um **template/documentação**. Nenhuma conexão real de OpenCode foi executada nesta máquina durante a criação dos adapters.

## Pré-requisitos

- O Collab MCP está rodando no host, em loopback (default `http://127.0.0.1:3100/mcp`).
- Você tem um **Bearer de transporte** próprio, emitido no host com `npm.cmd run auth:create -- "Seu Nome / OpenCode"`.
- Seu `prin_...` foi incluído em `allowedPrincipals` do workspace no `workspaces.json` do servidor. Um convite permite entrar na sala, mas **não substitui** essa lista.
- O OpenCode está rodando **no mesmo host** para o endpoint loopback atual. Em outro PC, use o runbook de Tailscale em `../tailscale/README.md`; ainda não há conexão remota configurada.

## Configuração recomendada (OpenCode V2)

O arquivo `opencode.json` deste diretório usa a sintaxe V2: os servidores ficam em `mcp.servers` (não em `mcp.<nome>`, que é V1).

1. Copie/merge o bloco `mcp.servers.collab` no `opencode.json` (ou `.jsonc`) do **projeto compartilhado** — não no repositório do Collab MCP.
2. Defina a variável de ambiente no processo do OpenCode:

   ```powershell
   $env:COLLAB_MCP_BEARER = "<BEARER_TOKEN>"
   opencode mcp list
   ```

   No PowerShell, a variável vale para a sessão atual. Para persistir, use o gerenciador de segredos/ambiente do seu sistema; nunca grave o token em `opencode.json`, `.env` versionado ou no workspace.

3. O template usa:

   ```json
   {
     "mcp": {
       "servers": {
         "collab": {
           "type": "remote",
           "url": "http://127.0.0.1:3100/mcp",
           "oauth": false,
           "codemode": false,
           "protocol": "legacy",
           "headers": {
             "Authorization": "Bearer {env:COLLAB_MCP_BEARER}"
           }
         }
       }
     }
   }
   ```

   - `oauth: false` é obrigatório: o servidor usa Bearer estático, não OAuth.
   - `codemode: false` mantém as tools expostas diretamente, com nomes estáveis; sem isso, o OpenCode V2 pode agrupá-las no Code Mode.
   - `protocol: "legacy"` fixa o handshake 2025-11-25 suportado pelo SDK atual do Collab MCP. Não use `protocol: "auto"`/`2026-07-28` sem testar interoperabilidade.
   - `{env:COLLAB_MCP_BEARER}` é a substituição oficial de ambiente do OpenCode; não use `$VAR` dentro do JSON.

4. Abra o OpenCode e use `/mcps` para conferir o servidor `collab`; ou rode:

   ```powershell
   opencode mcp list
   ```

   Esperado: `collab` conectado. O agente deve ver as 37 tools registradas; se o cliente prefixar os nomes com o nome do servidor, localize a tool pelo sufixo/nome real listado em `../shared/TOOL_REFERENCE.md`.

## Alternativa por CLI

A CLI do OpenCode V2 também adiciona servidores remotos:

```powershell
opencode mcp add collab --url http://127.0.0.1:3100/mcp --header 'Authorization=Bearer {env:COLLAB_MCP_BEARER}'
```

Depois **edite** a entrada gerada para incluir `"oauth": false` (e, se desejar, `"codemode": false` e `"protocol": "legacy"`). O template é mais previsível para evitar OAuth acidental e vazamento do header resolvido; use a CLI apenas se souber revisar o JSON final.

## Endpoint local e endpoint remoto futuro

| Cenário | URL |
|---|---|
| OpenCode no host, agora | `http://127.0.0.1:3100/mcp` |
| OpenCode em outro PC, após Tailscale Serve | `https://HOST.TAILNET.ts.net/mcp` |

Não abra `0.0.0.0`, não faça port forwarding no roteador e não use `tailscale funnel` (Funnel é público). O runbook de Tailscale está em `../tailscale/README.md` e **não** foi executado neste ambiente.

## Verificação rápida

No host, com a aplicação rodando:

```powershell
curl.exe http://127.0.0.1:3100/health
```

O `/health` é público e não contém tokens nem roots. Para validar o Bearer e o handshake MCP com o cliente oficial:

```powershell
$env:COLLAB_MCP_URL = "http://127.0.0.1:3100/mcp"
$env:COLLAB_MCP_BEARER = "<BEARER_TOKEN>"
npm.cmd run check:mcp
```

Esperado: `collab_status` ok, principal correto e 37 tools. O script nunca imprime o token. Ele vive no checkout do Collab MCP; sem esse checkout no cliente, use `opencode mcp list`/`/mcps` e uma chamada de tool como verificação.

## Instruções para o agente no projeto compartilhado

Copie `AGENTS.snippet.md` para o `AGENTS.md` do **projeto compartilhado** (ou inclua o conteúdo no arquivo de instruções já existente). Não copie para o `AGENTS.md` raiz do repositório do Collab MCP.

O snippet aponta para o protocolo completo em `adapters/shared/AGENT_PROTOCOL.md`; se o projeto compartilhado estiver em outra máquina/repositório, copie também os arquivos de `adapters/shared/` para um local acessível ao agente ou cole o conteúdo no arquivo de instruções do projeto.

## Troubleshooting

| Sintoma | Causa provável | Ação |
|---|---|---|
| 401 no `/mcp` | Bearer ausente, inválido ou revogado | Confira `COLLAB_MCP_BEARER` no processo do OpenCode; rode `auth:list` no host; gere/revogue conforme necessário |
| 403 | Sessão MCP criada por OUTRO principal (transporte) | Use sempre o Bearer que criou aquela sessão; não reutilize `Mcp-Session-Id` entre credenciais |
| `FORBIDDEN` na tool (HTTP 200, `isError`) | Principal sem `allowedPrincipals`, papel/sala sem permissão ou workspace fora da lista | Confira `allowedPrincipals`, `collab_list_workspaces` e o Bearer; convite não amplia workspace |
| 429 | Muitas tentativas Bearer inválidas | Respeite `Retry-After`; pare de tentar tokens |
| `Failed to connect` | App não está rodando, URL errada ou Host não permitido | Confira `/health`; em Tailscale, ajuste `COLLAB_ALLOWED_HOSTS` |
| Tools não aparecem | `codemode` agrupou as tools ou servidor não conectou | Use `/mcps`; revise `mcp.servers.collab`; reinicie o OpenCode |
| OAuth inesperado | `oauth: false` ausente | Adicione ao objeto do servidor |

## Segurança

- O template contém **apenas** a referência `{env:COLLAB_MCP_BEARER}`, nunca o token.
- Não compartilhe seu Bearer; ele identifica seu principal.
- O `sessionToken` retornado por `collab_create_room`/`collab_join_room` é diferente do Bearer e também é secreto.
- O arquivo `opencode.json` do projeto compartilhado pode ser versionado **somente** com a referência de ambiente; confirme que nenhum token foi colado nele.

## Fonte oficial consultada

- OpenCode V2 — MCP servers: https://opencode.ai/v2/docs/mcp-servers
- OpenCode config: https://opencode.ai/docs/config
