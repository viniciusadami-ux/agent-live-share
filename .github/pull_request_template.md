## Resumo

<!-- O que muda e por quê. Evite descrever apenas arquivos. -->

## Tipo de mudança

- [ ] Correção de bug
- [ ] Recurso
- [ ] Segurança/hardening
- [ ] Documentação
- [ ] Testes/infraestrutura
- [ ] Refatoração sem mudança de comportamento

## Testes executados

- [ ] `npm.cmd run typecheck`
- [ ] `npm.cmd test`
- [ ] `npm.cmd run build`
- [ ] `npm.cmd run smoke` (quando aplicável)
- [ ] `npm.cmd run check:mcp` (quando aplicável)

Cole resultados ou observações relevantes:

```text

```

## Segurança e privacidade

- [ ] Não adicionei tokens, Bearer, convites, roots reais ou dados privados.
- [ ] Não enfraqueci `allowedPrincipals`, validação de path, lock/hash ou checkpoint.
- [ ] Revisei logs, erros, fixtures e documentação para não vazar segredos.
- [ ] Mudanças de auth/autorização têm teste de regressão.

## Documentação

- [ ] README/CHANGELOG atualizados quando o comportamento público mudou.
- [ ] `AGENTS.md`/`CLAUDE.md` atualizados quando arquitetura, decisões ou escopo mudaram.
- [ ] `adapters/shared/TOOL_REFERENCE.md` atualizado se tools/campos mudaram.

## Migrations e compatibilidade

- [ ] Não alterei migrations já aplicadas.
- [ ] Se adicionei migration, usei versão nova e testei upgrade/rollback de transação.
- [ ] Se alterei tools, atualizei testes e o inventário de 37 tools quando aplicável.

## Issue relacionada

<!-- Ex.: Closes #123 -->
