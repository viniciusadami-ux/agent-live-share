/**
 * CLI administrativo LOCAL de credenciais de transporte.
 *
 * Uso (PowerShell, usar npm.cmd):
 *   npm.cmd run auth:create -- "Vinicius / OpenCode"
 *   npm.cmd run auth:list
 *   npm.cmd run auth:revoke -- prin_<uuid>
 *
 * - Abre o MESMO SQLite da aplicacao (COLLAB_DB_PATH), aplica as migrations
 *   de forma idempotente e fecha a conexao (operacao curta).
 * - O token em claro e impresso SOMENTE no `create`, uma unica vez.
 * - `list`/`revoke` NUNCA exibem token ou hash.
 * - Nenhum segredo e escrito em arquivo, log ou auditoria pelo CLI.
 *
 * Concorrencia: recomenda-se rodar com o servidor parado. Escritas curtas
 * com o servidor ativo sao suportadas pelo lock de arquivo do SQLite e pelo
 * `busy_timeout` configurado em `openDatabase`.
 */
import { ConfigError, loadConfig } from "../config/env.js";
import { collaborationMigrations } from "../collaboration/migrations/002_collaboration.js";
import { lockingMigrations } from "../locking/migrations/020_locking.js";
import {
  foundationMigrations,
  openDatabase,
  runMigrations,
  transportAuthMigrations,
} from "../persistence/index.js";
import {
  createPrincipal,
  listPrincipals,
  revokePrincipal,
} from "../server/auth/principals.js";
import { workspaceMigrations } from "../workspace/migrations/010_workspace.js";

const ALL_MIGRATIONS = [
  ...foundationMigrations,
  ...collaborationMigrations,
  ...workspaceMigrations,
  ...lockingMigrations,
  ...transportAuthMigrations,
] as const;

function usage(): void {
  console.log(
    [
      "Uso:",
      '  npm.cmd run auth:create -- "Nome / Cliente"',
      "  npm.cmd run auth:list",
      "  npm.cmd run auth:revoke -- <principalId>",
      "",
      "O token Bearer e exibido SOMENTE na criacao. Nunca o versione ou compartilhe.",
    ].join("\n"),
  );
}

function commandCreate(name: string): void {
  const { principal, token } = createPrincipal(db, name);
  console.log("Principal criado com sucesso.");
  console.log(`  id:   ${principal.id}`);
  console.log(`  name: ${principal.name}`);
  console.log("");
  console.log("BEARER TOKEN (exibido UMA vez; configure-o no cliente MCP):");
  console.log(token);
  console.log("");
  console.log("Guarde-o agora. O servidor persistiu apenas o hash SHA-256.");
}

function commandList(): void {
  const principals = listPrincipals(db);
  if (principals.length === 0) {
    console.log("Nenhuma credencial cadastrada. Use `npm.cmd run auth:create -- \"Nome\"`.");
    return;
  }
  console.log(`${principals.length} credencial(is):`);
  for (const principal of principals) {
    const revoked = principal.revokedAt === undefined ? "" : ` revokedAt=${principal.revokedAt}`;
    console.log(
      `  ${principal.id} | ${principal.status.padEnd(7)} | ${principal.createdAt}${revoked} | ${principal.name}`,
    );
  }
  console.log("(token e hash nunca sao exibidos nesta listagem)");
}

function commandRevoke(id: string): void {
  const principal = revokePrincipal(db, id);
  console.log(`Principal ${principal.id} -> status=${principal.status}.`);
  console.log("A revogacao bloqueia o transporte na proxima requisicao.");
}

// Conexao unica, aberta antes do switch e fechada no finally.
const config = loadConfig();
const db = openDatabase(config.dbPath);

try {
  runMigrations(db, ALL_MIGRATIONS);
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "create": {
      const name = args.join(" ").trim();
      if (name.length === 0) {
        usage();
        process.exitCode = 2;
        break;
      }
      commandCreate(name);
      break;
    }
    case "list":
      commandList();
      break;
    case "revoke": {
      const id = args[0]?.trim() ?? "";
      if (id.length === 0) {
        usage();
        process.exitCode = 2;
        break;
      }
      commandRevoke(id);
      break;
    }
    default:
      usage();
      process.exitCode = 2;
  }
} catch (error) {
  const message =
    error instanceof ConfigError || error instanceof Error ? error.message : String(error);
  // Mensagens de dominio/config nao contem segredo; nunca imprimimos stack.
  console.error(`[auth-cli] Falha: ${message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
