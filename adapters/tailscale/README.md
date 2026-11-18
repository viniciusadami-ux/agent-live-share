# Runbook — acesso remoto privado com Tailscale Serve

> **Estado neste ambiente:** Tailscale **não** está instalado/configurado, nenhum host/ACL/firewall foi alterado e nenhum acesso remoto foi validado. Este documento é um runbook verificável para o operador, não uma promessa de que o acesso remoto já funciona.

Objetivo: manter o Collab MCP escutando **somente em loopback** (`127.0.0.1:3100`) e publicar esse listener no tailnet via **Tailscale Serve HTTPS**, sem port forwarding no roteador e sem `tailscale funnel` (Funnel é público).

## Arquitetura

```text
PC do host                                      PC do amigo
┌──────────────────────────────┐                ┌──────────────────────────────┐
│ Collab MCP :3100 (loopback)  │                │ OpenCode / Codex / Claude    │
│        ▲                     │                │        │                     │
│        │ HTTP 127.0.0.1      │                │        │ HTTPS MagicDNS      │
│ Tailscale Serve (HTTPS 443)  │◄───────────────┤ Tailscale client             │
│        │ tailnet privado     │                │        │                     │
└──────────────────────────────┘                └──────────────────────────────┘
```

- O listener da aplicação **não** muda para `0.0.0.0`.
- O Tailscale Serve termina TLS e encaminha para `http://127.0.0.1:3100`.
- O acesso é restrito pelo tailnet/ACL e pelo Bearer do principal.
- A autorização por workspace continua sendo `allowedPrincipals` no servidor.

## Pré-requisitos

- [ ] Collab MCP compilado/rodando no host; `/health` local responde 200.
- [ ] Um principal criado com `npm.cmd run auth:create -- "Nome / Cliente"`; guarde o `prin_...` e o Bearer uma única vez.
- [ ] O `prin_...` do principal do amigo está em `allowedPrincipals` do workspace correto no `workspaces.json` do host.
- [ ] O workspace existe no host e o root é acessível pela conta que roda o Collab MCP.
- [ ] Tailscale instalado e autenticado no host e no cliente.
- [ ] MagicDNS e HTTPS certificates habilitados no tailnet.
- [ ] Nenhum `tailscale funnel` ativo para a porta; nenhum port forwarding no roteador.
- [ ] Plano de revogação/rotação definido (ver abaixo).

## 1. Instalar e autenticar o Tailscale

Instale pelo pacote oficial do seu sistema: https://tailscale.com/download

Exemplos usuais:

```powershell
# Windows (após instalar o pacote oficial e abrir um terminal novo)
tailscale up
tailscale status
```

```bash
# Linux (siga a instrução oficial da distribuição)
sudo tailscale up
tailscale status
```

No cliente (PC do amigo), faça o mesmo login no **mesmo tailnet** e confirme que o host aparece:

```powershell
tailscale status
tailscale ping <host-ou-magicdns>
```

Não use uma conta/tailnet diferente. Não instale Tailscale automaticamente por este repositório.

## 2. Habilitar HTTPS e MagicDNS

O Tailscale Serve precisa de certificado HTTPS e de um nome DNS do tailnet.

- Admin console → **DNS**: habilite **MagicDNS** e **HTTPS Certificates**.
  https://login.tailscale.com/admin/dns
- O nome do host será algo como `host-name.tailnet-name.ts.net`.
- A primeira execução de `tailscale serve` pode abrir um fluxo interativo para habilitar HTTPS; siga a instrução oficial.

## 3. Publicar o listener loopback com Serve

No host, com o Collab MCP em `127.0.0.1:3100`:

```powershell
tailscale serve --bg 3100
tailscale serve status
```

O `--bg` mantém o Serve ativo após o terminal fechar (comportamento documentado). O status mostra a URL HTTPS e o proxy para `http://127.0.0.1:3100`. Exemplo de saída (nomes ilustrativos):

```text
https://host-name.tailnet-name.ts.net
|-- / proxy http://127.0.0.1:3100
```

Notas oficiais:

- Apenas `http://127.0.0.1` é suportado como destino de proxy do Serve.
- HTTPS usa certificado provisionado automaticamente; não desabilite validação TLS.
- Para desfazer: `tailscale serve reset` (remove a configuração de Serve) ou o comando `off` correspondente.
- **Não use `tailscale funnel`**: Funnel publica na internet. Este runbook é somente tailnet.

Se o Serve não estiver habilitado no tailnet, siga o fluxo interativo exibido por `tailscale serve` (ele pode abrir uma página de consentimento para habilitar HTTPS).

## 4. Configurar o Collab MCP para o hostname do proxy

O Host header recebido pela aplicação precisa constar em `COLLAB_ALLOWED_HOSTS`. A aplicação continua em loopback.

Exemplo (host `host-name.tailnet-name.ts.net`):

```powershell
$env:COLLAB_HOST = "127.0.0.1"
$env:COLLAB_PORT = "3100"
$env:COLLAB_ALLOWED_HOSTS = "127.0.0.1,localhost,[::1],host-name.tailnet-name.ts.net"
# Opcional; ver análise abaixo:
# $env:COLLAB_TRUST_PROXY = "1"
# $env:COLLAB_TRUSTED_PROXY_IPS = "127.0.0.1,::1,::ffff:127.0.0.1"
npm.cmd run dev
```

Regras:

- `COLLAB_ALLOWED_HOSTS` é lista explícita, **sem wildcard**, sem esquema/porta. Use exatamente o hostname que o Serve envia no header `Host`.
- Confirme o Host efetivo no cliente:
  ```powershell
  curl.exe -v https://host-name.tailnet-name.ts.net/health
  ```
  Se o header exibido for o MagicDNS, adicione esse valor. Se houver 403 de Host, ajuste a lista e reinicie o servidor.
- `COLLAB_HOST` continua `127.0.0.1`; não troque para `0.0.0.0`.

### `COLLAB_TRUST_PROXY` e rate limiting

O Serve é um reverse proxy local; para o Collab MCP, as requisições podem chegar de `127.0.0.1`. O rate limiting de Bearer inválido usa o endereço do par e, somente se `COLLAB_TRUST_PROXY=1` e o par estiver em `COLLAB_TRUSTED_PROXY_IPS`, considera `X-Forwarded-For`.

- **Conservador (primeiro teste):** mantenha `COLLAB_TRUST_PROXY=0`. Tokens válidos não são afetados; tentativas inválidas de todos os clientes atrás do proxy compartilham a chave `127.0.0.1` (proteção mais grosseira, porém sem confiar em header).
- **Se o Serve encaminhar `X-Forwarded-For` e você quiser rate limit por cliente:** habilite `COLLAB_TRUST_PROXY=1` e mantenha `COLLAB_TRUSTED_PROXY_IPS` com os endereços loopback do proxy (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`). Só habilite se o listener estiver restrito a loopback e o proxy for confiável; caso contrário, um cliente local poderia forjar o header.
- Não há garantia neste runbook de que sua versão do Serve envie `X-Forwarded-For`; valide antes de habilitar. O header de identidade do Tailscale (`Tailscale-User-*`) **não** é usado para autorização: a autoridade continua sendo o Bearer + `allowedPrincipals`.

## 5. Configurar o cliente remoto

No PC do amigo, depois de entrar no tailnet:

1. Instale o cliente MCP (OpenCode/Codex/Claude Code) e use o Bearer **dele** (principal próprio).
2. Aponte a URL para `https://host-name.tailnet-name.ts.net/mcp` (não para `127.0.0.1`).
3. Mantenha o Bearer em variável de ambiente/gerenciador de segredos.
4. Confirme que o principal do amigo está em `allowedPrincipals` do workspace.

Exemplos de templates:

- OpenCode: `../opencode/README.md`
- Codex/ChatGPT desktop: `../codex/README.md`
- Claude Code: `../claude-code/README.md`
- Genérico: `../generic-mcp/README.md`

## 6. Validação passo a passo (host + cliente)

### 6.1 No host

```powershell
# 1) Aplicação local
curl.exe -i http://127.0.0.1:3100/health

# 2) Serviço do Tailscale
tailscale status
tailscale serve status

# 3) Host configurado
# (a saída não deve expor token; confira o hostname/porta)
```

Esperado: `/health` 200; `serve status` com o proxy para `127.0.0.1:3100`; URL MagicDNS correta.

### 6.2 No cliente

```powershell
# Health público (não exige Bearer)
curl.exe -i https://host-name.tailnet-name.ts.net/health

# /mcp sem token: deve ser 401 com WWW-Authenticate: Bearer
curl.exe -i https://host-name.tailnet-name.ts.net/mcp

# Handshake MCP + tools + collab_status com o Bearer do cliente
$env:COLLAB_MCP_URL = "https://host-name.tailnet-name.ts.net/mcp"
$env:COLLAB_MCP_BEARER = "<BEARER_TOKEN_DO_CLIENTE>"
npm.cmd run check:mcp
```

Esperado: `/health` 200; `/mcp` sem token 401; `check:mcp` com `collab_status` ok, principal correto e 37 tools.

> O script `check:mcp` vive no checkout do Collab MCP e depende das dependências Node desse checkout. Se o PC cliente não tiver o repositório, valide pelo status/tool list nativo do cliente (`/mcps`, `codex mcp list`, `claude mcp list`) e por uma chamada de tool; ou copie o script para um checkout com dependências.

> Se você receber **403** no handshake com Bearer válido, revise o Host/`COLLAB_ALLOWED_HOSTS` e se a sessão MCP pertence a outro principal. Se receber **401**, o Bearer está ausente/inválido/revogado. Se receber **429**, aguarde `Retry-After`. Negativas de **workspace** aparecem na tool como `isError`/`FORBIDDEN` (HTTP 200), não como HTTP 403.

### 6.3 Fluxo colaborativo real

Com dois clientes/principais distintos:

1. Cada principal chama `collab_list_workspaces` sem `token` (só Bearer) e confirma os `workspaceId` autorizados.
2. Coordinator cria sala: `collab_create_room` com o `workspaceId` autorizado.
3. Coordinator cria convite: `collab_create_invite`; entregue o `inviteToken` ao amigo por canal privado (não por MCP, arquivo do workspace ou chat público).
4. Amigo entra: `collab_join_room`.
5. Ambos confirmam `collab_room_state` e `collab_get_updates`.
5. Leitura: `collab_read_file` em um arquivo da fixture.
6. Lock: `collab_lock_acquire`; segundo cliente deve receber `LOCK_ALREADY_HELD` e conseguir negociar.
7. Patch: `collab_apply_patch` com `expectedHash` lido após o lock; releitura confirma o hash novo.
8. Checkpoint: coordinator inicia com zero locks, escrita é pausada, coordinator encerra.
9. Revogação: no host, `npm.cmd run auth:revoke -- prin_...`; o cliente deve receber 401 na próxima chamada.

Não use o workspace real para o primeiro teste; use `fixtures/demo-workspace`/`demo` do repositório.

## 7. Revogação e rotação

### Revogar acesso imediatamente

```powershell
# No host
npm.cmd run auth:revoke -- prin_<uuid>
```

- A revogação de transporte vale na próxima requisição (401).
- `collab_leave` revoga somente a sessão de sala, não o Bearer.
- Remover o `prin_...` de `allowedPrincipals` bloqueia workspace/lock/checkpoint na próxima chamada; não apaga salas/histórico. Exige editar `workspaces.json` no host e reiniciar/revalidar; não há tool remota para isso.

### Rotacionar (procedimento seguro)

1. `auth:create` para um **novo principal**; obtenha novo `prin_...` e novo Bearer.
2. Adicione o novo `prin_...` em `allowedPrincipals` do workspace e reinicie/revalide.
3. Atualize o cliente para o novo Bearer e valide `check:mcp`.
4. Remova o `prin_...` antigo da lista e reinicie/revalide.
5. `auth:revoke` no principal antigo.
6. Confirme que o cliente antigo recebe 401 e que o novo funciona.

Não tente “rotacionar” apenas trocando o token no cliente sem novo principal: a lista é por `PrincipalId`, e o Bearer é hash no banco; não há CLI de rotação in-place documentada nesta etapa.

## 8. Firewall, ACL e escopo

- **Não** abra a porta 3100 no firewall/roteador. O listener é loopback.
- O Serve escuta no tailnet; restrinja quem pode alcançar o host com ACL/grants do Tailscale: https://tailscale.com/docs/features/access-control
- Prefira usuários/dispositivos específicos; não conceda o tailnet inteiro se só o amigo precisa.
- Não use `tailscale funnel` nesta fase.
- Não desabilite a validação TLS nem use `https+insecure` para o cliente final.
- O Tailscale Serve adiciona headers de identidade, mas o Collab MCP **não** os usa como autorização; continue usando Bearer + `allowedPrincipals`.
- Um único processo deve abrir o SQLite; não rode dois Collab MCP no mesmo banco.

## 9. O que não fazer

- Não alterar `COLLAB_HOST` para `0.0.0.0`/`::`/IP público.
- Não configurar port forwarding, DMZ ou exposição direta.
- Não usar `tailscale funnel` (público).
- Não usar wildcard em `COLLAB_ALLOWED_HOSTS` ou `allowedPrincipals` (não suportado).
- Não colocar Bearer em URL, query string, `workspaces.json`, `opencode.json`, `config.toml`, `.mcp.json`, logs, issues ou mensagens.
- Não compartilhar `sessionToken` nem `inviteToken` por canais não privados.
- Não presumir que o MCP acorda o agente do amigo; ele precisa estar com o app/sessão ativo e consultando updates.
- Não afirmar que o acesso remoto está pronto antes de concluir a validação acima.

## 10. Limitações conhecidas deste runbook

- Tailscale **não** foi instalado nem configurado neste ambiente; os comandos acima são instruções, não execução validada.
- `allowedPrincipals` é administrado somente no host; não há tool/administrador remoto nesta rodada.
- A autorização é por workspace, não por sala; todos os principals listados podem criar/entrar em salas daquele workspace, respeitando convites/papéis.
- Rate limiting é em memória e por processo; atrás de proxy, a granularidade depende de `TRUST_PROXY`/`X-Forwarded-For`.
- Se o coordinator sair sem transferir, a sala fica sem coordinator ativo; não há failover automático.
- Sessões de sala e locks têm TTL (15 min/5 min); heartbeats são explícitos.

## Fontes oficiais consultadas

- Tailscale Serve (feature): https://tailscale.com/docs/features/tailscale-serve
- `tailscale serve` (CLI): https://tailscale.com/docs/reference/tailscale-cli/serve
- HTTPS certificates / MagicDNS: https://tailscale.com/docs/how-to/set-up-https-certificates
- Tailscale downloads: https://tailscale.com/download
- Tailscale access control: https://tailscale.com/docs/features/access-control
