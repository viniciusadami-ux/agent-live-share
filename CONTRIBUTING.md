# Contribuindo com Agent Live Share

Obrigado pelo interesse. Agent Live Share é um servidor MCP cooperativo para vários agentes no mesmo workspace. Contribuições são bem-vindas desde que preservem os limites atuais e não transformem o projeto em um sandbox ou orquestrador remoto sem uma decisão explícita de arquitetura.

Leia também [AGENTS.md](AGENTS.md) (documento central de decisões), [SECURITY.md](SECURITY.md) e o [Código de Conduta](CODE_OF_CONDUCT.md).

## Setup local

Requisitos:

- Node.js **>= 22.5**;
- npm;
- Windows é o ambiente principal validado; Linux/macOS são bem-vindos, mas o caminho de path/lock mais exercitado é Windows.

```powershell
npm.cmd ci
Copy-Item workspaces.example.json workspaces.json
npm.cmd run auth:create -- "Seu Nome / Dev"
```

No macOS/Linux, use `npm` e `cp workspaces.example.json workspaces.json`.

Copie o `prin_...` exibido para `allowedPrincipals` do workspace fixture em `workspaces.json` e guarde o Bearer apenas no ambiente do cliente. Nunca versione `workspaces.json`, `.env`, tokens, roots reais ou `data/`.

Inicie com `npm.cmd run dev` e valide com:

```powershell
$env:COLLAB_MCP_URL = "http://127.0.0.1:3100/mcp"
$env:COLLAB_MCP_BEARER = "collab_p_..."
npm.cmd run check:mcp
```

## Scripts

| Comando | Uso |
|---|---|
| `npm.cmd run typecheck` | TypeScript estrito |
| `npm.cmd test` | Suíte completa (200 testes / 24 arquivos no baseline) |
| `npm.cmd run build` | Compila `dist/` |
| `npm.cmd run smoke` | Smoke integrado real |
| `npm.cmd run smoke:foundation` | Smoke da fundação |
| `npm.cmd run check:mcp` | Handshake + tools + `collab_status` |
| `npm.cmd run auth:create -- "Nome / Dev"` | Cria principal e exibe o Bearer uma vez |
| `npm.cmd run auth:list` | Lista principals/status sem token |
| `npm.cmd run auth:revoke -- prin_...` | Revoga o transporte de um principal |

Rode os smokes **sequencialmente**: eles compartilham `.tmp-tests/` e limpam a raiz temporária.

## Arquitetura em uma página

- `src/application.ts` compõe migrations, catálogo e tools.
- `src/server/` contém HTTP/MCP, auth de transporte, sessões e health.
- `src/collaboration/` contém salas, mensagens, tarefas e handoffs.
- `src/workspace/` contém arquivos, patches, histórico/backups, checkpoints e autorização.
- `src/locking/` contém locks exclusivos por workspace/arquivo.
- `src/persistence/` contém SQLite e migrations versionadas.
- `adapters/` contém templates de clientes e o protocolo compartilhado; não é uma segunda implementação.

O transporte usa Bearer por principal e sessões de sala vinculadas a esse principal. A autorização por workspace é fail-closed via `allowedPrincipals`, configurada somente no servidor. `rootPath` nunca é aceito por tool. O modo cooperativo não intercepta ferramentas nativas de escrita/shell.

## Padrão de testes

- Use `tests/**` e fixtures em `.tmp-tests/`; nunca aponte testes para um workspace real.
- Toda correção de segurança/authz/lock/patch/checkpoint precisa de um teste de regressão.
- Prefira servidores MCP oficiais sobre HTTP real em porta efêmera quando o comportamento envolver transporte, sessão ou identidade.
- Para tempo, injete `now`/clock em vez de esperar relógio real; para rate limit, use o helper testável.
- Não remova testes existentes para “fazer passar”. Se o contrato mudou de propósito, atualize o teste e documente a decisão.
- Rode typecheck, suíte completa e build antes do PR. Se mexeu em HTTP/smoke, rode o smoke integrado.

## Segurança e segredos

- Nunca commite `.env`, `workspaces.json`, `workspaces.local.json`, `data/`, `dist/`, `node_modules/`, coverage, `.tmp-tests/` ou bancos SQLite.
- Nunca coloque Bearer, `sessionToken`, `inviteToken`, hash de token, roots reais do host, e-mails pessoais ou paths locais em código, fixtures, issues, logs ou documentação.
- Use os placeholders `collab_p_...`, `prin_...`, `<SESSION_TOKEN>` e caminhos relativos nos exemplos.
- Erros e logs não devem serializar segredos, conteúdo de arquivo ou rootPath.
- Vulnerabilidades: siga [SECURITY.md](SECURITY.md); não abra issue pública.

## Adicionando uma tool

1. Defina um schema Zod com limites explícitos e uma saída estruturada.
2. Autentique a sessão em toda chamada; derive agente/sala/principal do token/contexto, nunca de `agentId`/`roomId` fornecidos pelo modelo.
3. Revalide `allowedPrincipals` em operações de workspace/locking/checkpoint.
4. Registre auditoria sem tokens, roots ou conteúdo.
5. Adicione o nome em `COLLABORATION_TOOL_NAMES`, `WORKSPACE_TOOL_NAMES`, `LOCKING_TOOL_NAMES` ou `CHECKPOINT_TOOL_NAMES`.
6. Atualize `adapters/shared/TOOL_REFERENCE.md`, testes de inventário e a documentação de contagem.
7. Adicione testes de sucesso, negação, limites e concorrência quando aplicável.

## Adicionando uma migration

- A versão atual do schema é **30**. Não edite migrations já aplicadas.
- Crie uma migration nova com versão inteira única e maior que 30 (a próxima faixa reservada é **v40**).
- Rode dentro da transação do runner; falha deve fazer rollback completo.
- Se a migration pertence à composição real, inclua-a em `REQUIRED_ADDITIONAL_MIGRATIONS` ou no `startServer`/CLI apropriado.
- Adicione testes de instalação nova, DB existente, idempotência e upgrade.
- Atualize a versão esperada no health/CHANGELOG/docs quando mudar o schema público.

## Commits e pull requests

- Faça commits pequenos e focados; não misture formatação ampla com mudança de comportamento.
- Use mensagens claras no imperativo (ex.: `fix: reject stale hash before patch`).
- Um PR deve explicar problema, solução, testes, riscos e limitações.
- O template de PR inclui o checklist de testes, segurança, documentação e migrations.
- Mudanças de auth, autorização, paths, locks ou checkpoints exigem revisão conservadora.
- Não inclua artefatos gerados (`dist/`, coverage, bancos) no commit.

## Critérios de aceite

Uma contribuição está pronta quando:

- typecheck, suíte completa, build e smoke aplicável passam;
- não há segredos, roots ou paths locais no diff;
- autorização e validação de caminho continuam fail-closed;
- comportamento novo está documentado e testado;
- a mudança é compatível com o escopo cooperativo, ou propõe explicitamente uma mudança de arquitetura discutida antes.

## Licença

Ao contribuir, você concorda que sua contribuição é licenciada sob a MIT License deste repositório. Veja [LICENSE](LICENSE).
