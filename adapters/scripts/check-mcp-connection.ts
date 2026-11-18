/**
 * Verificação OPCIONAL de conexão com o Collab MCP, usando o cliente MCP oficial.
 *
 * Uso (PowerShell):
 *   $env:COLLAB_MCP_URL = "http://127.0.0.1:3100/mcp"
 *   $env:COLLAB_MCP_BEARER = "<BEARER_TOKEN>"
 *   npm.cmd run check:mcp
 *
 * - Não imprime o token, hash ou header Authorization.
 * - Não executa shell, não altera arquivos e não cria sala.
 * - Suporta o endpoint local (loopback) e o futuro endpoint HTTPS do Tailscale.
 *
 * Este script é uma ferramenta de diagnóstico do adapter; não faz parte do
 * servidor e não substitui os testes de integração.
 */
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface CheckMcpConnectionOptions {
  readonly url: string;
  readonly bearerToken: string;
  readonly clientName?: string;
}

export interface CheckMcpConnectionResult {
  readonly status: "ok";
  readonly serverName: string;
  readonly serverVersion: string;
  readonly protocolVersion: string;
  readonly principalId: string;
  readonly principalName: string;
  readonly toolCount: number;
  readonly toolNames: readonly string[];
}

interface StatusReport {
  readonly status?: unknown;
  readonly serverName?: unknown;
  readonly serverVersion?: unknown;
  readonly protocolVersion?: unknown;
  readonly principalId?: unknown;
  readonly principalName?: unknown;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Resposta de collab_status sem ${field} valido.`);
  }
  return value;
}

function parseStatusReport(result: unknown): StatusReport {
  const candidate = result as {
    readonly structuredContent?: unknown;
    readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  };
  if (typeof candidate.structuredContent === "object" && candidate.structuredContent !== null) {
    return candidate.structuredContent as StatusReport;
  }
  const text = candidate.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") {
    throw new Error("collab_status nao retornou structuredContent nem texto.");
  }
  try {
    return JSON.parse(text) as StatusReport;
  } catch {
    throw new Error("collab_status retornou texto que nao e JSON.");
  }
}

/** Remove o token de qualquer mensagem antes de imprimir/retornar. */
export function redactToken(text: string, bearerToken: string): string {
  if (bearerToken.length === 0) return text;
  return text.split(bearerToken).join("[redacted]");
}

function validateOptions(options: CheckMcpConnectionOptions): void {
  if (options.bearerToken.trim().length === 0) {
    throw new Error("Bearer ausente. Defina COLLAB_MCP_BEARER no ambiente.");
  }
  let parsed: URL;
  try {
    parsed = new URL(options.url);
  } catch {
    throw new Error("COLLAB_MCP_URL invalida: use uma URL absoluta http(s).");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("COLLAB_MCP_URL deve usar http:// (local) ou https:// (remoto).");
  }
}

/**
 * Conecta, lista as tools e chama `collab_status`. Lança erro sanitizado em
 * falha; o chamador nunca recebe o token de volta.
 */
export async function checkMcpConnection(
  options: CheckMcpConnectionOptions,
): Promise<CheckMcpConnectionResult> {
  validateOptions(options);
  const token = options.bearerToken.trim();
  const client = new Client({
    name: options.clientName ?? "collab-mcp-adapter-check",
    version: "0.1.0",
  });

  try {
    const transport = new StreamableHTTPClientTransport(new URL(options.url), {
      requestInit: {
        headers: { Authorization: `Bearer ${token}` },
      },
    });
    await client.connect(transport);

    const { tools } = await client.listTools();
    const result = await client.callTool({
      name: "collab_status",
      arguments: {},
    });
    if (result.isError === true) {
      throw new Error("collab_status retornou isError=true.");
    }

    const status = parseStatusReport(result);
    if (status.status !== "ok") {
      throw new Error("collab_status nao retornou status=ok.");
    }

    return {
      status: "ok",
      serverName: requireString(status.serverName, "serverName"),
      serverVersion: requireString(status.serverVersion, "serverVersion"),
      protocolVersion: requireString(status.protocolVersion, "protocolVersion"),
      principalId: requireString(status.principalId, "principalId"),
      principalName: requireString(status.principalName, "principalName"),
      toolCount: tools.length,
      toolNames: tools.map((tool) => tool.name),
    };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const message = redactToken(raw, token);
    const hints: string[] = [];
    if (/\b401\b/.test(message)) {
      hints.push("401: confira COLLAB_MCP_BEARER (ausente, invalido ou revogado).");
    }
    if (/\b403\b/.test(message)) {
      hints.push(
        "403: verifique o principal, allowedPrincipals e se a sessao pertence a este principal.",
      );
    }
    if (/\b429\b/.test(message)) {
      hints.push("429: respeite Retry-After; nao repita tentativas invalidas.");
    }
    throw new Error(
      [message, ...hints].join(hints.length === 0 ? "" : "\n"),
    );
  } finally {
    try {
      await client.close();
    } catch {
      // Fechamento best-effort; nao mascara o erro original.
    }
  }
}

function usage(): void {
  console.log(
    [
      "Uso:",
      "  $env:COLLAB_MCP_URL = \"http://127.0.0.1:3100/mcp\"",
      "  $env:COLLAB_MCP_BEARER = \"<BEARER_TOKEN>\"",
      "  npm.cmd run check:mcp",
      "",
      "O token nunca e impresso. /health e publico; /mcp exige Bearer.",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const url = process.env["COLLAB_MCP_URL"]?.trim() || "http://127.0.0.1:3100/mcp";
  const token = process.env["COLLAB_MCP_BEARER"]?.trim();

  if (token === undefined || token.length === 0) {
    console.error("[check:mcp] Defina COLLAB_MCP_BEARER no ambiente.");
    usage();
    process.exitCode = 2;
    return;
  }

  try {
    const result = await checkMcpConnection({ url, bearerToken: token });
    // Nunca ecoa o token (inclusive se o operador o colocou por engano na URL).
    console.log(`[check:mcp] Conectado a ${redactToken(url, token)}`);
    console.log(
      `[check:mcp] Servidor ${result.serverName} v${result.serverVersion} (${result.protocolVersion})`,
    );
    console.log(
      `[check:mcp] Principal ${result.principalName} (${result.principalId})`,
    );
    console.log(`[check:mcp] ${result.toolCount} tools registradas:`);
    for (const name of result.toolNames) console.log(`  - ${name}`);
    console.log("[check:mcp] collab_status OK (token nao impresso).");
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    console.error(`[check:mcp] Falha: ${redactToken(raw, token)}`);
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  void main();
}
