import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthenticatedPrincipal } from "../contracts/index.js";
import { diagnosticsToolModule } from "./diagnostics.js";
import type { ToolContext, ToolModule } from "./composition.js";

/**
 * Cria um `McpServer` por sessao do transporte (padrao do exemplo oficial
 * `simpleStreamableHttp.ts`).
 *
 * O principal autenticado e passado EXPLICITAMENTE pelo `httpApp` no momento
 * do handshake e congelado no `ToolContext` DESTA sessao. Isso e a autoridade
 * primaria de identidade: nao depende de async context, funciona igual para
 * POST/GET/DELETE/SSE e isola sessoes MCP concorrentes de principals distintos.
 * O `httpApp` tambem recusa (403) qualquer requisição posterior cujo Bearer
 * nao corresponda ao principal que criou a sessao.
 */
export function createMcpServer(
  context: ToolContext,
  principal: AuthenticatedPrincipal,
  extraModules: readonly ToolModule[] = [],
): McpServer {
  const sessionContext: ToolContext = {
    ...context,
    authenticatedPrincipal: principal,
  };

  const server = new McpServer({
    name: sessionContext.config.serverName,
    version: sessionContext.config.serverVersion,
  });

  diagnosticsToolModule(server, sessionContext);
  for (const module of extraModules) {
    module(server, sessionContext);
  }

  return server;
}
