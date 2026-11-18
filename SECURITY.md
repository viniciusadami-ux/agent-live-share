# Segurança — Agent Live Share

## Versões suportadas

A versão pública atual é **0.1.x**. Correções de segurança serão aplicadas na linha 0.1 até que uma nova linha estável seja declarada.

## Como reportar uma vulnerabilidade

**Não abra uma issue pública para vulnerabilidades.**

Use o canal privado do GitHub:

**https://github.com/viniciusadami-ux/agent-live-share/security/advisories/new**

Inclua, quando possível:

- versão/commit afetado;
- sistema operacional e versão do Node;
- cliente MCP/transporte usado;
- passos mínimos de reprodução;
- impacto esperado e observado;
- logs sanitizados, sem tokens, convites, roots ou conteúdo privado.

Não há e-mail de segurança publicado, SLA garantido ou programa de recompensa. O reporte será tratado de forma privada e responsável; não divulgue publicamente antes de uma correção ou de um acordo explícito.

## Escopo

São especialmente relevantes:

- autenticação Bearer de transporte, revogação e vínculo entre principal, sessão MCP e sessão de sala;
- vazamento de tokens, hashes, convites ou roots;
- autorização por workspace (`allowedPrincipals`) e bypass de `create_room`/`join_room`/`create_invite`;
- path traversal, symlink/junction, ADS, UNC, drive, nomes reservados do Windows e escapes do root;
- isolamento entre salas/workspaces e autorização de coordinator/reviewer;
- locks, `expectedHash`, patches, histórico/restauração, checkpoints e recuperação de journal;
- SQL injection e validação de entrada/saída;
- rate limiting de Bearer inválido, validação de Host e comportamento atrás de proxy;
- arquivos de configuração, templates de clientes e documentação que possam induzir a uma configuração insegura.

## O que este projeto NÃO protege

O escopo acima não deve ser interpretado como sandbox. Limites conhecidos:

- **Modo cooperativo:** ferramentas nativas de edição, shell, `git`, scripts e automações locais podem ignorar locks, hashes, checkpoints e a autorização por workspace. O servidor só protege operações que passam pelo MCP.
- **Operador/root do host:** quem controla a máquina, o SQLite ou o processo do servidor pode ler e alterar arquivos, banco e configuração. Não há isolamento contra o proprietário do host.
- **Roots reais:** `rootPath` é configuração local do servidor, nunca aceito por tool. O arquivo `workspaces.json` contém caminhos reais e deve ficar fora do workspace compartilhado e do Git.
- **Sem autorização por sala:** hoje a autorização de transporte/workspace é por principal e workspace, não por sala ou role. Convites e papéis da sala organizam a colaboração, mas `allowedPrincipals` é a fronteira de workspace.
- **Sem administração remota:** `allowedPrincipals` só muda editando a configuração do servidor e reiniciando/revalidando. Não há tool administrativa remota.
- **Rate limiting não é DDoS protection:** é em memória, por processo e incide sobre tentativas Bearer inválidas; operações válidas não têm orçamento por principal.
- **Acesso remoto não está pronto:** o binding padrão é loopback. Tailscale Serve, ACL, proxy, `allowedHosts` e TLS são runbook/template; não foram validados neste repositório.
- **Sem OAuth, sem modo estrito:** Bearer estático por principal; ferramentas nativas não são interceptadas. Bridge stdio e adaptadores de modo estrito não existem.
- **CLI e SQLite:** o CLI administrativo abre o mesmo banco em outro processo. Recomenda-se servidor parado para operações administrativas.
- **Sessão de sala:** um SSE já aberto por principal revogado pode permanecer até o stream fechar; novas requisições já recebem 401.

## Segredos e privacidade

- Bearer (`collab_p_`), token de sessão (`collab_s_`) e convite (`collab_i_`) são segredos distintos.
- O servidor persiste somente SHA-256; o texto puro do Bearer é exibido uma vez pelo CLI e nunca deve ir para arquivos versionados.
- Não coloque segredos em `workspaces.json`, `.env` versionado, logs, issues, mensagens, handoffs ou nomes de arquivo.
- Logs/auditoria não devem conter token, hash, root ou conteúdo de arquivo. Se encontrar vazamento, reporte pelo canal privado.

## Dependências

`npm audit --omit=dev` deve permanecer sem vulnerabilidades de produção. Advisories exclusivamente de desenvolvimento (Vitest/Vite) são acompanhados separadamente; upgrades major não são aplicados automaticamente sem validação da suíte.

## Divulgação

Correções podem ser publicadas sem aviso prévio para proteger usuários. Quando apropriado, o CHANGELOG registrará a correção sem detalhes que ampliem o risco antes da atualização.
