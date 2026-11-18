import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerConfig } from "../config/env.js";
import type { AuthenticatedPrincipal } from "../contracts/index.js";
import type { DatabaseConnection } from "../persistence/index.js";

/**
 * PONTOS DE COMPOSICAO DA FUNDACAO.
 *
 * Proximas frentes NAO precisam alterar estes arquivos: basta passar
 * `toolModules` e/ou `additionalMigrations` em `startServer(...)`.
 * Mantenha a superficie pequena: sem framework de plugins, sem registro global.
 */

/** Estado mutavel de transporte, compartilhado entre HTTP e as ferramentas. */
export interface FoundationRuntime {
  activeTransportSessions: number;
}

/** Contexto minimo entregue a cada modulo de ferramentas. */
export interface ToolContext {
  readonly config: ServerConfig;
  readonly db: DatabaseConnection;
  readonly startedAt: string;
  readonly migrationVersion: number;
  readonly appliedMigrations: number;
  /**
   * Principal autenticado no transporte, CAPTURADO POR SESSAO MCP.
   * `createMcpServer` constroi um contexto por sessao a partir do principal
   * validado no handshake; os ToolModules leem daqui e NUNCA aceitam
   * identidade de argumentos fornecidos pelo modelo.
   */
  readonly authenticatedPrincipal: AuthenticatedPrincipal;
  /** true quando o transporte exige Bearer (producao). */
  readonly authEnabled: boolean;
  /**
   * Sessoes HTTP do TRANSPORTE MCP (Streamable HTTP). Nao confundir com a
   * entidade `Session` de agente do dominio, que sera implementada depois.
   */
  readonly getActiveTransportSessions: () => number;
}

/**
 * Um modulo de ferramentas registra suas tools no `McpServer` recebido.
 * O registro e sincrono (a API `registerTool` do SDK e sincrona); handlers
 * assincronos podem ser registrados normalmente dentro do modulo.
 */
export type ToolModule = (server: McpServer, context: ToolContext) => void;
