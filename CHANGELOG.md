# Changelog

Todas as mudanças notáveis deste projeto são documentadas aqui.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o versionamento segue [Semantic Versioning](https://semver.org/lang/pt-BR/).

## [0.1.0] - 2026-11-18

Primeira versão pública local/cooperativa do Agent Live Share (codename interno Collab MCP).

### Adicionado

- Servidor MCP com transporte Streamable HTTP e 37 tools.
- Salas com coordinator, worker e reviewer; convites, heartbeat, estado da sala e transferência explícita de coordenação.
- Mensagens de sala e diretas, polling por cursor, solicitações de plano e respostas correlacionadas.
- Tarefas com dependências, progresso, bloqueios, conclusão, handoffs e revisão.
- Catálogo de workspaces allowlisted e descoberta de workspaces autorizados ao principal.
- Leitura, busca, listagem, patch delimitado, criação de arquivo, histórico, backups e restauração de versão.
- Locks exclusivos por workspace/arquivo com heartbeat, expiração, negociação e `expectedHash`.
- Checkpoints globais por workspace que pausam mutações, com encerramento anti-deadlock e eventos de autoria.
- Journal de escrita e recuperação conservadora após interrupção.
- Autenticação Bearer por principal com SHA-256, revogação imediata, rate limiting de tentativas inválidas e `allowedHosts`.
- Autorização por workspace via `allowedPrincipals` fail-closed, revalidada em operações sensíveis.
- CLI local `auth:create`, `auth:list` e `auth:revoke`.
- `check:mcp` para handshake, inventário de tools e `collab_status` sem ação destrutiva.
- Templates/documentação para OpenCode, Codex/ChatGPT desktop, Claude Code, MCP genérico e Tailscale Serve.
- Suíte com 200 testes em 24 arquivos, typecheck, build, smokes e CI para Windows/Node 24.
- Migrations versionadas até a v30; health público com versão de migration e estado básico.

### Segurança

- Tokens de transporte, sessão e convite persistidos somente como SHA-256.
- Sessões de sala vinculadas ao principal de transporte; um `sessionToken` vazado não é utilizável por outro principal.
- Paths relativos normalizados; symlink, junction, ADS, UNC, drive e nomes reservados do Windows rejeitados.
- Consultas SQL parametrizadas; respostas de erro sem caminho absoluto do filesystem.
- `zod` atualizado para 4.6.7; `npm audit --omit=dev` sem vulnerabilidades de produção.
- Três advisories de desenvolvimento na cadeia Vitest/Vite foram reportados na auditoria desta publicação; não afetam o runtime publicado.

### Limitações conhecidas

- Modo cooperativo: ferramentas nativas de escrita/shell podem ignorar locks, hashes, checkpoints e autorização.
- Binding padrão loopback; nenhum cliente real ou Tailscale foi conectado/validado nesta versão.
- Sem delete, rename/move, criação de diretórios, bridge stdio, OAuth, modo estrito ou UI.
- Sem autorização por sala/role e sem administração remota de `allowedPrincipals`.
- Sem operações Git, benchmarks ou promessa de prontidão para uso remoto/multiempresa.
- Node.js 24+ é exigido. Node 22 não é suportado nesta versão: `better-sqlite3@13.2.0` não obteve prebuild compatível no CI Windows/Node 22 e o fallback `node-gyp` não reconheceu o Visual Studio 18 do runner.
