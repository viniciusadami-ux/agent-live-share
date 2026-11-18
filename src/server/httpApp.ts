import { randomUUID } from "node:crypto";
import type { Express, Request, RequestHandler, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig } from "../config/env.js";
import type { Logger } from "../config/logger.js";
import type { AuthenticatedPrincipal, PrincipalId } from "../contracts/index.js";
import type { FoundationRuntime, ToolContext, ToolModule } from "./composition.js";
import { createMcpServer } from "./mcpServer.js";
import { TEST_PRINCIPAL } from "./auth/principalContext.js";
import { getRequestPrincipal } from "./auth/transportAuth.js";

export interface HttpAppOptions {
  readonly config: ServerConfig;
  readonly toolContext: ToolContext;
  readonly toolModules: readonly ToolModule[];
  readonly runtime: FoundationRuntime;
  readonly logger: Logger;
  /** true quando o transporte exige Bearer (producao). */
  readonly authEnabled: boolean;
  /** Middleware de auth; ausente somente em `disabled-for-tests`. */
  readonly authMiddleware?: RequestHandler;
}

export interface HttpApp {
  readonly app: Express;
  readonly getActiveSessionCount: () => number;
  readonly closeSessions: () => Promise<void>;
}

interface McpSession {
  readonly transport: StreamableHTTPServerTransport;
  readonly principalId: PrincipalId;
}

function jsonRpcError(code: number, message: string): object {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

function sessionIdOf(req: Request): string | undefined {
  const value = req.headers["mcp-session-id"];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value[0] !== undefined) return value[0];
  return undefined;
}

export type HealthPayload = {
  readonly status: "ok";
  readonly server: { readonly name: string; readonly version: string };
  readonly protocol: { readonly transport: "streamable-http"; readonly version: string };
  readonly persistence: {
    readonly driver: string;
    readonly migrationVersion: number;
    readonly appliedMigrations: number;
  };
  /** Nunca contem tokens, hashes, roots ou caminho do SQLite. */
  readonly auth: { readonly enabled: boolean };
  readonly endpoints: { readonly mcp: string; readonly health: string };
  readonly startedAt: string;
  readonly uptimeMs: number;
  readonly activeTransportSessions: number;
};

export function buildHealthPayload(
  config: ServerConfig,
  context: ToolContext,
  authEnabled: boolean,
): HealthPayload {
  return {
    status: "ok",
    server: { name: config.serverName, version: config.serverVersion },
    protocol: { transport: "streamable-http", version: LATEST_PROTOCOL_VERSION },
    persistence: {
      driver: context.db.driver,
      migrationVersion: context.migrationVersion,
      appliedMigrations: context.appliedMigrations,
    },
    auth: { enabled: authEnabled },
    endpoints: { mcp: config.mcpPath, health: config.healthPath },
    startedAt: context.startedAt,
    uptimeMs: Math.max(0, Date.now() - Date.parse(context.startedAt)),
    activeTransportSessions: context.getActiveTransportSessions(),
  };
}

/**
 * Aplicacao HTTP: endpoint MCP (POST/GET/DELETE) + health (GET).
 *
 * `createMcpExpressApp` instala `express.json()` e a validacao de Host usando
 * a lista EXPLICITA `config.allowedHosts` (protecao contra DNS rebinding).
 * O middleware de auth cobre TODAS as rotas /mcp; /health fica publico.
 */
export function createHttpApp(options: HttpAppOptions): HttpApp {
  const {
    config,
    toolContext,
    toolModules,
    runtime,
    logger,
    authEnabled,
    authMiddleware,
  } = options;
  const app = createMcpExpressApp({
    host: config.host,
    allowedHosts: [...config.allowedHosts],
  });
  const sessions = new Map<string, McpSession>();

  const syncRuntime = (): void => {
    runtime.activeTransportSessions = sessions.size;
  };

  // Health nao exige Authorization e nao retorna dados sensiveis.
  app.get(config.healthPath, (_req: Request, res: Response) => {
    res.status(200).json(buildHealthPayload(config, toolContext, authEnabled));
  });

  if (authMiddleware !== undefined) {
    // app.use(path, mw) cobre POST/GET/DELETE e qualquer sub-rota de /mcp.
    app.use(config.mcpPath, authMiddleware);
  }

  /** Resolve o principal ja validado pelo middleware (ou sentinela de teste). */
  const principalOf = (req: Request): AuthenticatedPrincipal | undefined => {
    if (!authEnabled) return TEST_PRINCIPAL;
    return getRequestPrincipal(req);
  };

  const denyForbidden = (res: Response): void => {
    res.status(403).json({ error: "forbidden" });
  };

  app.post(config.mcpPath, (req: Request, res: Response) => {
    void (async () => {
      const principal = principalOf(req);
      if (principal === undefined) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="collab-mcp"');
        res.status(401).json({ error: "unauthorized" });
        return;
      }

      const sessionId = sessionIdOf(req);
      try {
        if (sessionId !== undefined) {
          const existing = sessions.get(sessionId);
          if (existing === undefined) {
            res.status(404).json(jsonRpcError(-32001, "Session not found"));
            return;
          }
          if (existing.principalId !== principal.id) {
            // Identidade valida, mas sem autorizacao sobre ESTA sessao.
            denyForbidden(res);
            return;
          }
          await existing.transport.handleRequest(req, res, req.body);
          return;
        }

        if (!isInitializeRequest(req.body)) {
          res.status(400).json(
            jsonRpcError(-32000, "Bad Request: No valid session ID provided"),
          );
          return;
        }

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string): void => {
            sessions.set(newSessionId, { transport, principalId: principal.id });
            syncRuntime();
          },
          onsessionclosed: (closedSessionId: string): void => {
            sessions.delete(closedSessionId);
            syncRuntime();
          },
        });

        transport.onclose = () => {
          if (transport.sessionId !== undefined) {
            sessions.delete(transport.sessionId);
          }
          syncRuntime();
        };
        transport.onerror = (error: Error) => {
          logger.warn(`Erro no transporte MCP: ${error.message}`);
        };

        const server = createMcpServer(toolContext, principal, toolModules);
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        logger.error(
          `Falha ao tratar POST ${config.mcpPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (!res.headersSent) {
          res.status(500).json(jsonRpcError(-32603, "Internal server error"));
        }
      }
    })();
  });

  const handleSessionRequest = (req: Request, res: Response): void => {
    void (async () => {
      const principal = principalOf(req);
      if (principal === undefined) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="collab-mcp"');
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      const sessionId = sessionIdOf(req);
      if (sessionId === undefined) {
        res.status(400).send("Missing session ID");
        return;
      }
      const session = sessions.get(sessionId);
      if (session === undefined) {
        res.status(404).json(jsonRpcError(-32001, "Session not found"));
        return;
      }
      if (session.principalId !== principal.id) {
        denyForbidden(res);
        return;
      }
      try {
        await session.transport.handleRequest(req, res);
      } catch (error) {
        logger.error(
          `Falha ao tratar ${req.method} ${config.mcpPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (!res.headersSent) {
          res.status(500).json(jsonRpcError(-32603, "Internal server error"));
        }
      }
    })();
  };

  app.get(config.mcpPath, handleSessionRequest);
  app.delete(config.mcpPath, handleSessionRequest);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "not_found" });
  });

  const closeSessions = async (): Promise<void> => {
    const transports = [...sessions.values()].map((session) => session.transport);
    sessions.clear();
    syncRuntime();
    await Promise.all(
      transports.map(async (transport) => {
        try {
          await transport.close();
        } catch (error) {
          logger.warn(
            `Falha ao fechar transporte MCP: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );
  };

  return {
    app,
    getActiveSessionCount: () => sessions.size,
    closeSessions,
  };
}
