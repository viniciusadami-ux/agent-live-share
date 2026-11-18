# OpenAI Codex / ChatGPT desktop — Collab MCP

Este diretório contém **template e documentação**. Nenhuma conexão real do Codex/ChatGPT desktop foi validada nesta máquina.

O ChatGPT desktop app, o Codex CLI e a extensão de IDE compartilham a mesma configuração MCP do host Codex. O servidor Collab MCP usa **Streamable HTTP com Bearer estático**; não usa OAuth.

## Pré-requisitos

- Collab MCP rodando no host em loopback: `http://127.0.0.1:3100/mcp`.
- Bearer próprio, emitido no host com `npm.cmd run auth:create -- "Seu Nome / Codex"`.
- Seu `prin_...` incluído em `allowedPrincipals` do workspace no servidor. Um convite permite entrar na sala, mas **não substitui** essa lista.
- Para o endpoint loopback atual, o Codex deve rodar **no mesmo host**. Em outro PC, use o runbook de Tailscale em `../tailscale/README.md`; o acesso remoto ainda não está configurado.
- O Codex/ChatGPT desktop precisa estar **aberto e com sessão ativa** e conseguir alcançar a URL configurada. O Collab MCP não inicia, acorda ou mantém o app do agente ativo.

## config.toml (recomendado)

O template `config.toml` usa os campos oficiais de MCP Streamable HTTP:

```toml
[mcp_servers.collab]
url = "http://127.0.0.1:3100/mcp"
bearer_token_env_var = "COLLAB_MCP_BEARER"
startup_timeout_sec = 30
tool_timeout_sec = 120
enabled = true
```

Locais:

- global: `~/.codex/config.toml` (no Windows: `C:\Users\<usuario>\.codex\config.toml`);
- por projeto: `.codex/config.toml` na raiz do **projeto compartilhado** (Codex só lê configuração de projeto confiável).

O arquivo de projeto pode ser versionado porque contém apenas o **nome** da variável de ambiente, nunca o token.

Defina a variável no processo que inicia o Codex:

```powershell
$env:COLLAB_MCP_BEARER = "<BEARER_TOKEN>"
codex mcp list
codex mcp get collab
```

O valor real é o Bearer `collab_p_...` emitido pelo `auth:create`; nunca o coloque no `config.toml`, em um arquivo do workspace, em prompt/chat ou em commit. Para o app desktop, a variável precisa estar disponível ao processo do app: configure-a no ambiente do usuário/serviço ou use o gerenciador de segredos do sistema e **reinicie o app**; não presuma que o app herdará uma variável definida apenas em outro terminal.

Equivalente pela CLI do Codex (quando disponível):

```powershell
codex mcp add collab --url http://127.0.0.1:3100/mcp --bearer-token-env-var COLLAB_MCP_BEARER
```

O comando pode gravar a entrada em `config.toml`; confira com `codex mcp get collab` e mantenha apenas o nome da variável.

## ChatGPT desktop app

O app desktop compartilha a configuração MCP do host Codex. O fluxo oficial é:

1. Abra **Settings** → **MCP servers**.
2. **Add server**.
3. Nome: `collab`; transporte: **STREAMABLE HTTP**; URL: `http://127.0.0.1:3100/mcp` (ou a URL HTTPS do Tailscale).
4. Salve e use **Restart**.
5. O `/mcp` no compositor mostra os servidores conectados.

Para autenticação Bearer estática, prefira configurar `bearer_token_env_var` no `config.toml` do host Codex e reiniciar o app. A UI de “Add server” não deve ser usada para colar tokens em texto; o token deve vir do ambiente/segredo do processo.

## Verificação

No host:

```powershell
curl.exe http://127.0.0.1:3100/health
```

Com o cliente oficial (sem imprimir o token):

```powershell
$env:COLLAB_MCP_URL = "http://127.0.0.1:3100/mcp"
$env:COLLAB_MCP_BEARER = "<BEARER_TOKEN>"
npm.cmd run check:mcp
```

Esperado: `collab_status` ok, principal correto e 37 tools. O script vive no checkout do Collab MCP; sem esse checkout no cliente, use `codex mcp get collab`/`codex mcp list` e uma chamada de tool como verificação.

No Codex:

```powershell
codex mcp list
codex mcp get collab
```

## Instruções para o agente no projeto compartilhado

Copie `AGENTS.snippet.md` para o `AGENTS.md` do **projeto compartilhado** (não para o `AGENTS.md` raiz do Collab MCP). O Codex lê `AGENTS.md` do projeto; se o projeto já tiver instruções, faça merge do conteúdo.

O snippet resume o protocolo obrigatório. O texto completo está em `adapters/shared/AGENT_PROTOCOL.md` no repositório do Collab MCP (ou no material do operador).

## Local vs. remoto

| Cenário | URL | Requisito |
|---|---|---|
| Codex/desktop no mesmo host | `http://127.0.0.1:3100/mcp` | app e servidor na mesma máquina |
| Codex/desktop em outro PC | `https://HOST.TAILNET.ts.net/mcp` | Tailscale Serve configurado no host + `COLLAB_ALLOWED_HOSTS`; ver `../tailscale/README.md` |

Um app em outro PC **não** alcança `127.0.0.1` do host. Não abra o listener em `0.0.0.0` nem faça port forwarding no roteador.

## Troubleshooting

| Sintoma | Causa provável | Ação |
|---|---|---|
| 401 | Bearer ausente/inválido/revogado | Confirme que `COLLAB_MCP_BEARER` existe no processo que iniciou o Codex; reinicie CLI/app; confira `auth:list` no host |
| `codex mcp list` mostra configurado mas falha | Variável não visível no processo do app | Defina no ambiente do app/serviço e reinicie; valide com `check:mcp` |
| 403 | Sessão MCP criada por OUTRO principal (transporte) | Use sempre o Bearer que criou a sessão; não reutilize `Mcp-Session-Id` entre credenciais |
| `FORBIDDEN` na tool (HTTP 200, `isError`) | Principal sem `allowedPrincipals`, papel/sala sem permissão ou workspace fora da lista | Confira `allowedPrincipals`, `collab_list_workspaces` e o Bearer |
| 429 | Muitas tentativas inválidas | Respeite `Retry-After`; não faça retry com tokens aleatórios |
| OAuth | Codex tentou OAuth por não encontrar Bearer | Configure `bearer_token_env_var`; confirme a variável no processo |
| Tools ausentes | Servidor não conectou ou tools desabilitadas no Codex | `/mcp`, `codex mcp get collab`, `enabled_tools`/`disabled_tools` |
| Host inválido atrás de proxy | `COLLAB_ALLOWED_HOSTS` não inclui o hostname do Tailscale | Use o hostname explícito, sem wildcard, e reinicie o servidor |

## Segurança

- O template usa `bearer_token_env_var`; não há token hardcoded.
- Não compartilhe seu Bearer nem o `sessionToken` da sala.
- O `sessionToken` é retornado uma vez por `collab_create_room`/`collab_join_room` e fica somente em memória.
- O arquivo de configuração de projeto contém apenas o nome da variável; confirme isso antes de commitar.
- ChatGPT desktop/Codex em outra máquina só deve conectar após Tailscale/ACL e autorização por workspace.

## Fontes oficiais consultadas

- OpenAI Codex — MCP: https://developers.openai.com/codex/extend/mcp
- OpenAI Codex — configuração: https://developers.openai.com/codex/config-file/config-reference
- OpenAI Codex — CLI MCP: `codex mcp add`, `codex mcp list`, `codex mcp get`
