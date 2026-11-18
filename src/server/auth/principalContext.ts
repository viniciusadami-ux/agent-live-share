import { AsyncLocalStorage } from "node:async_hooks";
import {
  DomainError,
  asPrincipalId,
  type AuthenticatedPrincipal,
} from "../../contracts/index.js";

/**
 * Contexto assincrono da identidade de transporte.
 *
 * O middleware HTTP executa `runWithPrincipal(principal, () => next())`, o que
 * mantem o principal disponivel para TODO o processamento assincrono da
 * requisicao (POST/GET/DELETE e streams SSE), inclusive dentro dos handlers
 * do SDK. E defesa em profundidade: a autoridade primaria e o principal
 * CAPTURADO POR SESSAO MCP em `createMcpServer` (ver composition.ts), que nao
 * depende do async context de bibliotecas terceiras.
 *
 * Nenhum token/hash e armazenado aqui, apenas id e nome seguros.
 */
const storage = new AsyncLocalStorage<AuthenticatedPrincipal>();

/**
 * Principal sentinela usado SOMENTE por `transportAuth.mode = "disabled-for-tests"`
 * e por fixtures de servico. O ID segue o formato `prin_...` para poder constar
 * em `allowedPrincipals` de fixtures sem excecoes no validador de formato.
 */
export const TEST_PRINCIPAL: AuthenticatedPrincipal = {
  id: asPrincipalId("prin_test-transport-principal"),
  name: "test-transport-principal",
};

export function runWithPrincipal<T>(
  principal: AuthenticatedPrincipal,
  fn: () => T,
): T {
  return storage.run(principal, fn);
}

export function getCurrentPrincipal(): AuthenticatedPrincipal | undefined {
  return storage.getStore();
}

export function requireCurrentPrincipal(): AuthenticatedPrincipal {
  const principal = storage.getStore();
  if (principal === undefined) {
    throw new DomainError(
      "FORBIDDEN",
      "Identidade de transporte ausente no contexto da requisicao.",
      {
        hint: "Conecte-se ao endpoint MCP com um Bearer token valido emitido pelo CLI administrativo.",
      },
    );
  }
  return principal;
}
