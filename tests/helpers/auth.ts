import type { PrincipalId } from "../../src/contracts/index.js";
import type { DatabaseConnection } from "../../src/persistence/index.js";
import { createPrincipal } from "../../src/server/auth/principals.js";

export interface TestCredential {
  readonly id: PrincipalId;
  readonly name: string;
  readonly token: string;
}

/**
 * Emite uma credencial de transporte de teste no SQLite da aplicacao ja aberta.
 * O token em claro so existe neste objeto de teste (equivalente ao CLI create).
 */
export function issueTestCredential(
  db: DatabaseConnection,
  name: string,
): TestCredential {
  const { principal, token } = createPrincipal(db, name);
  return { id: principal.id, name: principal.name, token };
}
