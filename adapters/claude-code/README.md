# Claude Code — Collab MCP

Este diretório contém **template e documentação**. Nenhuma conexão real do Claude Code foi executada nesta máquina. Claude Code é compatibilidade universal/secundária nesta rodada, mas usa o mesmo endpoint e contrato.

## Pré-requisitos

- Collab MCP rodando no host em loopback: `http://127.0.0.1:3100/mcp`.
- Bearer próprio, emitido no host com `npm.cmd run auth:create -- "Seu Nome / Claude Code"`.
- Seu `prin_...` incluído em `allowedPrincipals` do workspace no servidor. Um convite permite entrar na sala, mas **não substitui** essa lista.
- Para loopback, Claude Code deve rodar no mesmo host. Em outro PC, use o runbook de Tailscale em `../tailscale/README.md`; o acesso remoto ainda não está configurado.

## Configuração recomendada: `.mcp.json` do projeto compartilhado

Copie `mcp.json.example` para `.mcp.json` na raiz do **projeto compartilhado**:

```json
{
  "mcpServers": {
    "collab": {
      "type": "http",
      "url": "http://127.0.0.1:3100/mcp",
      "headers": {
        "Authorization": "Bearer ${COLLAB_MCP_BEARER}"
      }
    }
  }
}
```

- `type: "http"` é o transporte Streamable HTTP (`streamable-http` também é aceito como alias).
- `${COLLAB_MCP_BEARER}` é a expansão oficial de variável de ambiente do Claude Code em `.mcp.json`; não coloque o token literal no arquivo.
- Arquivos `.mcp.json` de projeto precisam de aprovação/confiança na primeira utilização. O arquivo pode ser versionado **somente** com a referência `${...}`.
- Defina a variável no ambiente do processo do Claude Code:

  ```powershell
  $env:COLLAB_MCP_BEARER = "<BEARER_TOKEN>"
  claude mcp list
  claude mcp get collab
  ```

  Se a variável não existir, Claude Code avisa e pode enviar o literal `${COLLAB_MCP_BEARER}` (não autenticado); confira o status em `/mcp`.

## Comando oficial da CLI

A CLI aceita HTTP com header:

```bash
claude mcp add --transport http collab http://127.0.0.1:3100/mcp \
  --header "Authorization: Bearer ${COLLAB_MCP_BEARER}"
```

> **Cuidado:** o shell expande `${COLLAB_MCP_BEARER}` antes de chamar a CLI, e algumas versões do Claude Code gravam o header resolvido na configuração. Para evitar segredo em repouso, prefira o `.mcp.json` com `${COLLAB_MCP_BEARER}` ou use `add-json` com o placeholder literal e confirme o conteúdo gravado:
>
> ```bash
> claude mcp add-json collab \
>   '{"type":"http","url":"http://127.0.0.1:3100/mcp","headers":{"Authorization":"Bearer ${COLLAB_MCP_BEARER}"}}'
> ```
>
> Depois de qualquer comando, rode `claude mcp get collab` e remova/rotacione qualquer token que tenha sido gravado.

Escopos: `local` (default, só você no projeto), `project` (`.mcp.json` compartilhado) e `user` (todos os projetos). O template é pensado para `.mcp.json` de projeto.

## Verificação

```powershell
curl.exe http://127.0.0.1:3100/health
```

Com o cliente oficial:

```powershell
$env:COLLAB_MCP_URL = "http://127.0.0.1:3100/mcp"
$env:COLLAB_MCP_BEARER = "<BEARER_TOKEN>"
npm.cmd run check:mcp
```

Esperado: `collab_status` ok, principal correto e 37 tools. No Claude Code, use `/mcp` para ver o servidor e o número de tools; `claude mcp list` mostra o status. O script vive no checkout do Collab MCP; sem esse checkout no cliente, use os comandos nativos do Claude Code.

## Instruções para o agente no projeto compartilhado

Copie `CLAUDE.snippet.md` para o `CLAUDE.md` do **projeto compartilhado** (ou faça merge no arquivo de instruções existente). Não copie para o `AGENTS.md` raiz do Collab MCP.

O snippet resume o protocolo; o texto completo está em `adapters/shared/AGENT_PROTOCOL.md` no repositório do Collab MCP (ou no material do operador).

## Local vs. remoto

| Cenário | URL | Requisito |
|---|---|---|
| Claude Code no host | `http://127.0.0.1:3100/mcp` | app e servidor na mesma máquina |
| Claude Code em outro PC | `https://HOST.TAILNET.ts.net/mcp` | Tailscale Serve + `COLLAB_ALLOWED_HOSTS`; ver `../tailscale/README.md` |

Um cliente em outro PC não alcança o loopback do host. Não use `0.0.0.0`, port forwarding ou `tailscale funnel`.

## Troubleshooting

| Sintoma | Causa provável | Ação |
|---|---|---|
| 401 | Bearer ausente/inválido/revogado | Defina `COLLAB_MCP_BEARER` no processo; confira `auth:list` no host |
| 403 | Sessão MCP criada por OUTRO principal (transporte) | Use sempre o Bearer que criou a sessão; não reutilize `Mcp-Session-Id` entre credenciais |
| `FORBIDDEN` na tool (HTTP 200, `isError`) | Principal sem `allowedPrincipals`, papel/sala sem permissão ou workspace fora da lista | Confira `allowedPrincipals`, `collab_list_workspaces` e o Bearer |
| `Needs authentication` | Cliente tentando OAuth ou header vazio | Remova OAuth/garanta `Authorization` não vazio; o servidor é Bearer estático |
| Header com whitespace | Token colado com espaço/quebra de linha | Remova o whitespace; o Claude Code alerta sem ecoar o valor |
| Tools ausentes | Servidor não conectou ou `.mcp.json` não aprovado | `/mcp`, `claude mcp get collab`, aprove o projeto |
| Host inválido atrás de proxy | `COLLAB_ALLOWED_HOSTS` sem o hostname do Tailscale | Adicione o hostname explícito e reinicie o servidor |

## Segurança

- O template contém apenas `${COLLAB_MCP_BEARER}`, nunca o token.
- Não compartilhe Bearer nem `sessionToken`; o primeiro autentica o principal, o segundo a sala.
- Verifique `.mcp.json` e a configuração local após qualquer `claude mcp add` para garantir que nenhum token literal foi persistido.
- Em caso de exposição, revogue no host (`auth:revoke`) e rotacione; session tokens podem ser encerrados com `collab_leave`.

## Fontes oficiais consultadas

- Claude Code — MCP: https://code.claude.com/docs/en/mcp
- Claude Code — MCP quickstart: https://code.claude.com/docs/en/mcp-quickstart
- Claude Code — expansão de variáveis em `.mcp.json`: https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json
