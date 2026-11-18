# Cliente MCP genérico — requisitos mínimos

O Collab MCP é um servidor **MCP Streamable HTTP** com autenticação **Bearer estática por principal**. Qualquer cliente MCP que cumpra os requisitos abaixo pode usar o mesmo servidor, sem adaptador específico.

## Requisitos de transporte

- Endpoint: `POST/GET/DELETE /mcp` no host do servidor, por padrão `http://127.0.0.1:3100/mcp`.
- Transporte: **Streamable HTTP** (não apenas SSE; não stdio).
- Protocolo baseline: revisão **2025-11-25** (SDK MCP v1). O servidor abre com o handshake clássico `initialize`.
- Header obrigatório em **todas** as requisições `/mcp`:
  ```http
  Authorization: Bearer <BEARER_TOKEN>
  ```
  O Bearer é configurado no cliente (variável de ambiente/gerenciador de segredos), **nunca** como argumento de tool.
- O cliente deve preservar `Mcp-Session-Id` retornado pelo servidor e enviá-lo nas requisições seguintes da mesma sessão MCP.
- O cliente deve aceitar respostas `application/json` e `text/event-stream` no mesmo endpoint, conforme Streamable HTTP.
- `GET /health` é público e não exige Bearer. Não contém tokens, roots nem caminho do SQLite.

## Respostas HTTP

| Status | Significado |
|---|---|
| 200 | Requisição MCP aceita |
| 400 | Requisição MCP inválida/sem sessão no handshake |
| 401 | Bearer ausente, formato inválido, inexistente ou revogado; corpo `{"error":"unauthorized"}` e `WWW-Authenticate: Bearer` |
| 403 | Identidade válida tentando reutilizar uma sessão MCP de outro principal. Negativas de workspace/papel chegam na tool como `isError` + `FORBIDDEN`, não como HTTP 403 |
| 404 | Sessão MCP desconhecida |
| 429 | Excesso de tentativas Bearer inválidas; respeite `Retry-After` |

O cliente não deve reenviar o Bearer para outras origens/redirects. Use exatamente a URL configurada e HTTPS no acesso remoto.

## Capacidades

O servidor registra **37 tools**:

- 1 diagnóstico (`collab_status`);
- 20 de colaboração;
- 8 de workspace;
- 3 de checkpoint;
- 5 de locking.

O inventário completo, campos e retornos está em `../shared/TOOL_REFERENCE.md`. O protocolo operacional obrigatório está em `../shared/AGENT_PROTOCOL.md`.

As tools de colaboração/workspace/locking/checkpoint, exceto criação/ingresso de sala, recebem `token` = token de sessão de sala, retornado uma vez por `collab_create_room` ou `collab_join_room`. O Bearer de transporte é separado.

## O que o cliente precisa suportar para uma boa experiência

- Headers HTTP customizados por servidor;
- variável de ambiente/segredo para o Bearer (sem hardcode no arquivo versionado);
- descoberta de tools (`tools/list`) e chamada (`tools/call`);
- respostas com conteúdo texto e `structuredContent`;
- erros de tool com `isError: true` e envelope `{ok:false,tool,error}`;
- timeouts compatíveis com chamadas de arquivo/patch (o servidor não executa shell nem jobs longos; 60–120 s é suficiente para o uso normal);
- tolerância a `SESSION_INACTIVE`: o agente deve reingressar com novo convite; não há reconexão automática de sessão de sala.

## O que o servidor não oferece

- OAuth: o servidor usa Bearer estático. Clientes que exigem OAuth precisam de um bridge/adaptador futuro.
- STDIO nativo: um bridge stdio → HTTP é planejado, mas **não implementado**.
- Push de mensagens/eventos: use `collab_get_updates` por polling não bloqueante. O MCP não inicia/desperta aplicativos fechados.
- Shell/build/test remoto: não há tool de execução de comandos; testes/commits são do ambiente do agente/humano.
- Administração remota de `allowedPrincipals`: a lista é configuração do servidor (`workspaces.json`), não uma tool.
- Delete/rename/move de arquivos, criação de diretórios, branches/worktrees.

## Bridge stdio (futuro, não implementado)

Se o cliente só aceitar stdio, o desenho futuro é:

```text
Agente ↔ stdio ↔ collab-mcp-stdio ↔ HTTP ↔ Collab MCP
```

O bridge deve apenas transportar as mensagens e oferecer as mesmas capacidades; não deve reimplementar locks/tarefas/workspace. Até existir, use um cliente com suporte a Streamable HTTP ou um cliente MCP compatível com HTTP.

## Checklist de conexão

1. `GET /health` → 200.
2. `POST /mcp` com `initialize` e `Authorization: Bearer <BEARER_TOKEN>` → sessão criada.
3. `tools/list` → 37 tools.
4. `collab_status` → principal correto, `authEnabled: true`.
5. `collab_list_workspaces` sem `token` (só Bearer) → `id`/`name` autorizados.
6. `collab_create_room`/`collab_join_room` → `sessionToken`.
7. Leitura/lock/patch apenas no workspace autorizado.

## Segurança

- Bearer e `sessionToken` são segredos diferentes; nunca os compartilhe.
- O servidor persiste apenas hash do Bearer e do token de sessão/convite.
- A autorização por workspace é fail-closed (`allowedPrincipals`); um convite não amplia acesso.
- O modo atual é cooperativo: ferramentas nativas do cliente podem contornar o MCP. O agente deve evitar escritas nativas em arquivos compartilhados.
- Acesso remoto só após Tailscale Serve/ACL e revisão de `allowedHosts`/proxy; veja `../tailscale/README.md`.

## Fontes

- MCP Streamable HTTP: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- MCP: https://modelcontextprotocol.io/
