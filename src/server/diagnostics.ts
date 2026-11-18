import * as z from "zod/v4";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext, ToolModule } from "./composition.js";

/**
 * Diagnostico/status do servidor. Nao retorna caminhos do host (rootPath ou
 * caminho absoluto do SQLite), tokens, hashes ou convites. Pode incluir
 * principalId/name (dados seguros da identidade autenticada).
 */
export const DIAGNOSTICS_TOOL_NAME = "collab_status";

export type DiagnosticsReport = {
  readonly status: "ok";
  readonly serverName: string;
  readonly serverVersion: string;
  readonly protocolVersion: string;
  readonly transport: "streamable-http";
  readonly startedAt: string;
  readonly uptimeMs: number;
  readonly persistenceDriver: string;
  readonly migrationVersion: number;
  readonly appliedMigrations: number;
  readonly activeTransportSessions: number;
  readonly authEnabled: boolean;
  readonly principalId: string;
  readonly principalName: string;
};

export function buildDiagnosticsReport(context: ToolContext): DiagnosticsReport {
  return {
    status: "ok",
    serverName: context.config.serverName,
    serverVersion: context.config.serverVersion,
    protocolVersion: LATEST_PROTOCOL_VERSION,
    transport: "streamable-http",
    startedAt: context.startedAt,
    uptimeMs: Math.max(0, Date.now() - Date.parse(context.startedAt)),
    persistenceDriver: context.db.driver,
    migrationVersion: context.migrationVersion,
    appliedMigrations: context.appliedMigrations,
    activeTransportSessions: context.getActiveTransportSessions(),
    authEnabled: context.authEnabled,
    principalId: String(context.authenticatedPrincipal.id),
    principalName: context.authenticatedPrincipal.name,
  };
}

const diagnosticsOutputSchema = {
  status: z.literal("ok"),
  serverName: z.string(),
  serverVersion: z.string(),
  protocolVersion: z.string(),
  transport: z.literal("streamable-http"),
  startedAt: z.string(),
  uptimeMs: z.number(),
  persistenceDriver: z.string(),
  migrationVersion: z.number(),
  appliedMigrations: z.number(),
  activeTransportSessions: z.number(),
  authEnabled: z.boolean(),
  principalId: z.string(),
  principalName: z.string(),
};

export const diagnosticsToolModule: ToolModule = (server, context) => {
  server.registerTool(
    DIAGNOSTICS_TOOL_NAME,
    {
      title: "Collab MCP status",
      description:
        "Diagnostico do servidor: versao do protocolo MCP, estado da persistencia/migrations, " +
        "sessoes do transporte e a identidade de transporte autenticada (sem tokens ou caminhos do host). Somente leitura.",
      inputSchema: {},
      outputSchema: diagnosticsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (): CallToolResult => {
      const report = buildDiagnosticsReport(context);
      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
        structuredContent: report,
      };
    },
  );
};
