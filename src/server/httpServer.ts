import { createServer, type Server } from "node:http";
import {
  loadConfig,
  type AuthRateLimitConfig,
  type EnvSource,
  type ServerConfig,
} from "../config/env.js";
import { createLogger, type Logger } from "../config/logger.js";
import {
  foundationMigrations,
  openDatabase,
  runMigrations,
  transportAuthMigrations,
  type DatabaseConnection,
  type Migration,
  type MigrationRunResult,
} from "../persistence/index.js";
import { TEST_PRINCIPAL } from "./auth/principalContext.js";
import { countActivePrincipals } from "./auth/principals.js";
import { createAuthRateLimiter, type AuthRateLimiter } from "./auth/rateLimit.js";
import {
  createTransportAuthMiddleware,
  type TransportAuthConfig,
} from "./auth/transportAuth.js";
import type { FoundationRuntime, ToolContext, ToolModule } from "./composition.js";
import { createHttpApp } from "./httpApp.js";

export interface StartServerOptions {
  /** Omitido: `loadConfig()` le variaveis de ambiente com defaults seguros. */
  readonly config?: ServerConfig;
  readonly env?: EnvSource;
  readonly cwd?: string;
  readonly logger?: Logger;
  /** PONTO DE COMPOSICAO: modulos futuros registram suas ferramentas aqui. */
  readonly toolModules?: readonly ToolModule[];
  /** PONTO DE COMPOSICAO: modulos futuros adicionam suas migrations aqui. */
  readonly additionalMigrations?: readonly Migration[];
  /**
   * Autenticacao de transporte. PADRAO = "required" (seguro).
   * "disabled-for-tests" e uma opcao TIPADA e EXPLICITA usada apenas pelos
   * testes da fundacao; `startApplication`/entrypoint NUNCA a utilizam.
   */
  readonly transportAuth?: TransportAuthConfig;
  /** Override tipado dos limites (testes de rate limiting). */
  readonly authRateLimit?: AuthRateLimitConfig;
}

export interface RunningServer {
  readonly config: ServerConfig;
  readonly port: number;
  readonly url: string;
  readonly mcpUrl: string;
  readonly healthUrl: string;
  readonly startedAt: string;
  readonly database: DatabaseConnection;
  readonly migrationResult: MigrationRunResult;
  readonly authEnabled: boolean;
  readonly countActivePrincipals: () => number;
  close(): Promise<void>;
}

function closeHttpServer(server: Server): Promise<void> {
  // Garante que streams SSE/keep-alive nao mantenham o processo preso no Windows.
  server.closeAllConnections();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Inicializa SQLite + migrations, monta a aplicacao e abre o listener TCP.
 * `port: 0` (via COLLAB_PORT) produz uma porta efemera real, usada nos testes.
 */
export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const config = options.config ?? loadConfig(options.env, options.cwd);
  const logger = options.logger ?? createLogger(config.logLevel);

  const transportAuth: TransportAuthConfig = options.transportAuth ?? { mode: "required" };
  const authEnabled = transportAuth.mode === "required";

  const db = openDatabase(config.dbPath);
  let migrationResult: MigrationRunResult;
  try {
    migrationResult = runMigrations(db, [
      ...foundationMigrations,
      ...(options.additionalMigrations ?? []),
      ...(authEnabled ? transportAuthMigrations : []),
    ]);
  } catch (error) {
    db.close();
    throw error;
  }

  const rateLimiter: AuthRateLimiter = createAuthRateLimiter({
    limits: options.authRateLimit ?? config.authRateLimit,
  });
  const authMiddleware = authEnabled
    ? createTransportAuthMiddleware({
        db,
        rateLimiter,
        trustedProxy: config.trustedProxy,
        logger,
      })
    : undefined;

  const startedAt = new Date().toISOString();
  const runtime: FoundationRuntime = { activeTransportSessions: 0 };
  const toolContext: ToolContext = {
    config,
    db,
    startedAt,
    migrationVersion: migrationResult.currentVersion,
    appliedMigrations: migrationResult.totalApplied,
    // Substituido pelo principal real da sessao em `createMcpServer`.
    authenticatedPrincipal: TEST_PRINCIPAL,
    authEnabled,
    getActiveTransportSessions: () => runtime.activeTransportSessions,
  };

  const http = createHttpApp({
    config,
    toolContext,
    toolModules: options.toolModules ?? [],
    runtime,
    logger,
    authEnabled,
    ...(authMiddleware === undefined ? {} : { authMiddleware }),
  });

  const server: Server = createServer(http.app);
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(config.port, config.host, () => {
        server.off("error", onError);
        resolve();
      });
    });
  } catch (error) {
    await http.closeSessions();
    rateLimiter.dispose();
    db.close();
    throw error;
  }

  const address = server.address();
  if (address === null || typeof address === "string") {
    await http.closeSessions();
    await closeHttpServer(server);
    rateLimiter.dispose();
    db.close();
    throw new Error("Nao foi possivel determinar a porta TCP apos listen().");
  }

  const port = address.port;
  const hostForUrl = config.host.includes(":") ? `[${config.host}]` : config.host;
  const url = `http://${hostForUrl}:${port}`;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await http.closeSessions();
    await closeHttpServer(server);
    rateLimiter.dispose();
    db.close();
  };

  // Nunca loga o caminho do SQLite (evita expor estrutura do host).
  logger.debug(
    `SQLite pronto (driver ${db.driver}, migration v${migrationResult.currentVersion}, auth=${authEnabled ? "required" : "disabled-for-tests"})`,
  );

  return {
    config,
    port,
    url,
    mcpUrl: `${url}${config.mcpPath}`,
    healthUrl: `${url}${config.healthPath}`,
    startedAt,
    database: db,
    migrationResult,
    authEnabled,
    countActivePrincipals: () => (authEnabled ? countActivePrincipals(db) : 0),
    close,
  };
}
