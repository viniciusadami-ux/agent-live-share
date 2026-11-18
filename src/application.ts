import {
  ConfigError,
  loadConfig,
  type AuthRateLimitConfig,
  type EnvSource,
  type ServerConfig,
} from "./config/env.js";
import { createLogger, type Logger } from "./config/logger.js";
import {
  loadWorkspaceDefinitions,
  type LoadedWorkspaceDefinitions,
} from "./config/workspaces.js";
import {
  REQUIRED_ADDITIONAL_MIGRATIONS,
  createWorkspaceAuthorization,
  createWorkspaceCatalog,
  createWorkspaceStack,
  type WorkspaceAuthorization,
  type WorkspaceDefinition,
  type WorkspaceLimits,
} from "./workspace/index.js";
import { startServer, type RunningServer } from "./server/httpServer.js";

/**
 * Composicao EXECUTAVEL da aplicacao.
 *
 * `startServer` continua sendo a fundacao pura (usada em testes de composicao).
 * Esta funcao liga o produto real: migrations [1, 2, 10, 20, 30], catalogo de
 * workspaces vindo SOMENTE da configuracao do servidor e os ToolModules de
 * colaboracao + workspace + locking + checkpoints.
 *
 * SEGURANCA: o transporte HTTP exige autenticacao Bearer SEMPRE. Nao existe
 * opcao de desabilitar auth aqui (so em `startServer` com modo tipado de teste).
 * A migration 030 (principals + vinculo sessao/principal) e aplicada por
 * `startServer` automaticamente quando auth esta habilitada.
 *
 * AUTORIZACAO POR WORKSPACE (rodada 2): `allowedPrincipals` de cada workspace
 * vem SOMENTE de `workspaces.json` (ou `definitions` injetadas em testes).
 * Criamos UMA politica compartilhada e fail-closed no startup, validando roots
 * e IDs ANTES de subir o listener. A politica e passada ao stack e a TODAS as
 * sessoes MCP; `revalidateWorkspaces()` simula um reload de config (equivalente
 * a reiniciar com novo workspaces.json) e vale na proxima chamada de qualquer
 * sessao. Nao ha migration nova e nenhuma tabela com allowed lists editavel
 * remotamente.
 */
export interface StartApplicationOptions {
  readonly config?: ServerConfig;
  readonly env?: EnvSource;
  readonly cwd?: string;
  readonly logger?: Logger;
  /**
   * Definicoes explicitas (testes/fixtures). Quando presente, nenhum arquivo
   * `workspaces.json` e lido. Cada root/allowedPrincipals ainda e validado.
   */
  readonly definitions?: readonly WorkspaceDefinition[];
  readonly now?: () => Date;
  readonly limits?: Partial<WorkspaceLimits>;
  readonly sessionTtlMs?: number;
  readonly inviteTtlMs?: number;
  /** Override TIPADO dos limites de rate limiting (usado apenas em testes). */
  readonly authRateLimit?: AuthRateLimitConfig;
}

export interface RunningApplication extends RunningServer {
  /** IDs operacionais permitidos; NUNCA contem rootPath. */
  readonly workspaceIds: readonly string[];
  readonly workspaceCount: number;
  readonly workspaceSource: LoadedWorkspaceDefinitions["source"] | "explicit";
  /**
   * Revalida a configuracao de workspaces/principals em processo (operator
   * reload). Equivale a reiniciar com novo `workspaces.json`: valida tudo de
   * novo e, se valido, troca a politica compartilhada. Bloqueia/imede
   * imediatamente sessoes que perderam acesso, SEM apagar dados.
   * NAO e uma tool MCP: nao ha caminho remoto para alterar allowedPrincipals.
   */
  revalidateWorkspaces(definitions: readonly WorkspaceDefinition[]): void;
}

function resolveDefinitions(
  options: StartApplicationOptions,
): LoadedWorkspaceDefinitions | { definitions: readonly WorkspaceDefinition[]; source: "explicit" } {
  if (options.definitions !== undefined) {
    return { definitions: options.definitions, source: "explicit" };
  }
  return loadWorkspaceDefinitions({ env: options.env, cwd: options.cwd });
}

function configFailure(error: unknown): ConfigError {
  const message = error instanceof Error ? error.message : String(error);
  // Mensagens de dominio/config nao contem segredo/rootPath; nunca logamos token.
  return new ConfigError(`Configuracao de workspaces invalida: ${message}`);
}

export async function startApplication(
  options: StartApplicationOptions = {},
): Promise<RunningApplication> {
  const config = options.config ?? loadConfig(options.env, options.cwd);
  const logger = options.logger ?? createLogger(config.logLevel);
  const loaded = resolveDefinitions(options);
  const definitions = loaded.definitions;

  // FAIL-FAST: valida roots, IDs de workspace, formato/duplicatas de
  // allowedPrincipals e sobreposicao de roots ANTES de abrir o listener.
  let authorization: WorkspaceAuthorization;
  try {
    authorization = createWorkspaceAuthorization(definitions);
  } catch (error) {
    throw configFailure(error);
  }

  for (const definition of definitions) {
    const allowed = definition.allowedPrincipals ?? [];
    if (allowed.length === 0) {
      // Aviso operacional sem segredos: apenas o id opaco do workspace.
      logger.warn(
        `Workspace "${definition.id}" sem allowedPrincipals: nenhum principal autorizado (fail closed).`,
      );
    }
  }

  const running = await startServer({
    config,
    logger,
    transportAuth: { mode: "required" },
    ...(options.authRateLimit === undefined ? {} : { authRateLimit: options.authRateLimit }),
    additionalMigrations: REQUIRED_ADDITIONAL_MIGRATIONS,
    toolModules: [
      createWorkspaceStack({
        definitions,
        now: options.now,
        limits: options.limits,
        sessionTtlMs: options.sessionTtlMs,
        inviteTtlMs: options.inviteTtlMs,
        authorization,
      }),
    ],
  });

  try {
    // Espelho duravel do catalogo (idempotente). A politica ja foi validada.
    createWorkspaceCatalog(running.database, definitions, {
      now: options.now,
      authorization,
    });
  } catch (error) {
    await running.close();
    throw configFailure(error);
  }

  const revalidateWorkspaces = (next: readonly WorkspaceDefinition[]): void => {
    // `replace` valida TUDO antes de trocar; em erro, a politica anterior fica.
    authorization.replace(next);
    createWorkspaceCatalog(running.database, next, {
      now: options.now,
      authorization,
    });
  };

  return {
    ...running,
    // Getters: revalidateWorkspaces troca a politica em processo; a
    // introspeccao administrativa deve refletir o estado vigente, nao o
    // snapshot do startup.
    get workspaceIds(): readonly string[] {
      return authorization.entries().map((entry) => String(entry.id));
    },
    get workspaceCount(): number {
      return authorization.size;
    },
    workspaceSource: loaded.source,
    revalidateWorkspaces,
  };
}
