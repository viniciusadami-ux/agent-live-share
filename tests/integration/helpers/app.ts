import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startApplication, type RunningApplication } from "../../../src/application.js";
import { loadConfig, type ServerConfig } from "../../../src/config/env.js";
import { createSilentLogger } from "../../../src/config/logger.js";
import {
  foundationMigrations,
  openDatabase,
  runMigrations,
  transportAuthMigrations,
} from "../../../src/persistence/index.js";
import { collaborationMigrations } from "../../../src/collaboration/index.js";
import { workspaceMigrations } from "../../../src/workspace/migrations/010_workspace.js";
import { lockingMigrations } from "../../../src/locking/migrations/020_locking.js";
import type { WorkspaceDefinition, WorkspaceLimits } from "../../../src/workspace/index.js";
import type { TestClock } from "../../collaboration/helpers/fixture.js";
import { createTestClock } from "../../collaboration/helpers/fixture.js";
import { connectTestMcpClient, type TestMcpClient } from "../../foundation/helpers/mcpClient.js";
import { createTestDir } from "../../foundation/helpers/tmp.js";
import { issueTestCredential, type TestCredential } from "../../helpers/auth.js";

/**
 * Fixture de integracao multicliente:
 * - workspace REAL dentro de `.tmp-tests` (nunca um projeto real);
 * - mesmo SQLite para todos os clientes/sessoes;
 * - relogio injetavel para expiracao deterministica;
 * - `start()` usa a MESMA composicao do entrypoint (`startApplication`).
 *
 * AUTORIZACAO POR WORKSPACE (rodada 2): os principals sao criados ANTES do
 * `startApplication` (numa conexao curta ao mesmo SQLite), para que seus IDs
 * possam constar em `allowedPrincipals` das definitions. Sem isso, a politica
 * fail-closed nao autorizaria ninguem. Os tokens em claro ficam so na fixture.
 */
export interface IntegrationFixture {
  readonly dir: string;
  readonly root: string;
  /** Segundo root (nao sobreposto) para testes de isolamento/autorizacao. */
  readonly otherRoot: string;
  readonly dbPath: string;
  readonly config: ServerConfig;
  readonly definitions: readonly WorkspaceDefinition[];
  /** Credenciais pre-criadas (id + token), ja autorizadas nas definitions. */
  readonly credentials: readonly TestCredential[];
  readonly clock: TestClock;
}

export const INTEGRATION_FILES: Readonly<Record<string, string>> = {
  "login.html": "<h1>Login</h1>\n",
  "src/app.ts": 'export const app = "v1";\n',
  "shared.txt": "v1\n",
  "README.md": "# Fixture de integracao\n\nsearchable-token\n",
};

const ALL_MIGRATIONS = [
  ...foundationMigrations,
  ...collaborationMigrations,
  ...workspaceMigrations,
  ...lockingMigrations,
  ...transportAuthMigrations,
] as const;

export interface CreateIntegrationFixtureOptions {
  readonly clock?: TestClock;
}

export function createIntegrationFixture(
  options: CreateIntegrationFixtureOptions = {},
): IntegrationFixture {
  const dir = createTestDir("integration");
  const root = path.join(dir, "root");
  const otherRoot = path.join(dir, "other-root");
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(otherRoot, { recursive: true });
  for (const [relative, content] of Object.entries(INTEGRATION_FILES)) {
    const absolute = path.join(root, ...relative.split("/"));
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
  writeFileSync(path.join(otherRoot, "login.html"), "<h1>OUTRO WORKSPACE</h1>\n", "utf8");
  writeFileSync(path.join(otherRoot, "shared.txt"), "OUTRO\n", "utf8");

  const dbPath = path.join(dir, "app.sqlite");
  const config: ServerConfig = { ...loadConfig({}), port: 0, dbPath };

  // Conexao curta: migra o SQLite e emite as credenciais antes do startup.
  const db = openDatabase(dbPath);
  runMigrations(db, ALL_MIGRATIONS);
  const credentials: readonly TestCredential[] = [
    issueTestCredential(db, "Principal A / OpenCode"),
    issueTestCredential(db, "Principal B / Codex"),
    issueTestCredential(db, "Principal C / Claude Code"),
    issueTestCredential(db, "Principal D / Extra"),
  ];
  db.close();

  // Lista EXATA: os quatro principals podem usar ws_integration.
  const definitions: readonly WorkspaceDefinition[] = [
    {
      id: "ws_integration",
      name: "Workspace de integracao",
      rootPath: root,
      allowedPrincipals: credentials.map((credential) => credential.id),
    },
  ];
  return {
    dir,
    root,
    otherRoot,
    dbPath,
    config,
    definitions,
    credentials,
    clock: options.clock ?? createTestClock(),
  };
}

export interface StartIntegrationOptions {
  readonly sessionTtlMs?: number;
  readonly inviteTtlMs?: number;
  readonly limits?: Partial<WorkspaceLimits>;
}

export async function startIntegrationApp(
  fixture: IntegrationFixture,
  options: StartIntegrationOptions = {},
): Promise<RunningApplication> {
  return startApplication({
    config: fixture.config,
    definitions: fixture.definitions,
    now: fixture.clock.now,
    logger: createSilentLogger(),
    sessionTtlMs: options.sessionTtlMs ?? 3_600_000,
    inviteTtlMs: options.inviteTtlMs ?? 3_600_000,
    limits: options.limits,
  });
}

/**
 * Credencial pre-criada por indice. Substitui `issueAppCredential(app, name)`:
 * com fail-closed, um principal criado DEPOIS do startup nao estaria em
 * `allowedPrincipals`. O `name` so e mantido por compatibilidade de leitura.
 */
export function credentialOf(
  fixture: IntegrationFixture,
  index: number,
): TestCredential {
  const credential = fixture.credentials[index];
  if (credential === undefined) {
    throw new Error(`Fixture sem credencial no indice ${index}.`);
  }
  return credential;
}

export async function connectClient(
  app: RunningApplication,
  bearerToken: string,
): Promise<TestMcpClient> {
  return connectTestMcpClient(app.mcpUrl, bearerToken);
}

export interface Envelope<T> {
  readonly ok: true;
  readonly tool: string;
  readonly data: T;
}

export interface ErrorEnvelope {
  readonly ok: false;
  readonly tool: string;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly hint: string;
  };
}

export function successData<T>(result: unknown): T {
  const shaped = result as {
    readonly isError?: boolean;
    readonly structuredContent?: unknown;
  };
  if (shaped.isError === true) {
    throw new Error(`Tool falhou: ${JSON.stringify(shaped.structuredContent)}`);
  }
  const envelope = shaped.structuredContent as Envelope<T> | undefined;
  if (envelope === undefined || envelope.ok !== true) {
    throw new Error(`Resposta sem envelope de sucesso: ${JSON.stringify(result)}`);
  }
  return envelope.data;
}

export function errorData(result: unknown): ErrorEnvelope {
  const shaped = result as {
    readonly isError?: boolean;
    readonly structuredContent?: unknown;
  };
  if (shaped.isError !== true) {
    throw new Error(`Esperava erro da tool: ${JSON.stringify(shaped.structuredContent)}`);
  }
  return shaped.structuredContent as ErrorEnvelope;
}

export async function callOk<T>(
  client: TestMcpClient,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const result = await client.client.callTool({ name, arguments: args });
  return successData<T>(result);
}

export async function callError(
  client: TestMcpClient,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ErrorEnvelope> {
  const result = await client.client.callTool({ name, arguments: args });
  return errorData(result);
}

export function jsonOf(value: unknown): string {
  return JSON.stringify(value);
}
