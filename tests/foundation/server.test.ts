import { request as httpRequest } from "node:http";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { createSilentLogger } from "../../src/config/logger.js";
import { DIAGNOSTICS_TOOL_NAME, type DiagnosticsReport } from "../../src/server/diagnostics.js";
import {
  startServer,
  type RunningServer,
  type StartServerOptions,
} from "../../src/server/httpServer.js";
import type { ToolModule } from "../../src/server/composition.js";
import type { Migration } from "../../src/persistence/index.js";
import { connectTestMcpClient } from "./helpers/mcpClient.js";
import { cleanupTestRoot, createTestDir } from "./helpers/tmp.js";

const runningServers: RunningServer[] = [];

afterEach(async () => {
  for (const server of runningServers.splice(0)) {
    await server.close();
  }
});

afterAll(cleanupTestRoot);

type CompositionOptions = Pick<StartServerOptions, "toolModules" | "additionalMigrations">;

async function startTestServer(options: CompositionOptions = {}): Promise<RunningServer> {
  const config = {
    ...loadConfig({}),
    port: 0,
    dbPath: path.join(createTestDir("server"), "server.sqlite"),
  };
  const running = await startServer({
    ...options,
    config,
    logger: createSilentLogger(),
    // Fundacao pura: modo de teste TIPADO e explicito (sem auth, migration v1).
    transportAuth: { mode: "disabled-for-tests" },
  });
  runningServers.push(running);
  return running;
}

function getTextContent(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error("resultado MCP sem content");
  const block = content.find(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      (item as { type?: unknown }).type === "text",
  ) as { text?: unknown } | undefined;
  if (block === undefined || typeof block.text !== "string") {
    throw new Error("resultado MCP sem bloco de texto");
  }
  return block.text;
}

describe("servidor MCP Streamable HTTP — inicializacao real", () => {
  it("escuta em porta efemera real e responde GET /health", async () => {
    const running = await startTestServer();
    expect(running.port).toBeGreaterThan(0);
    expect(running.url).toContain("127.0.0.1");
    expect(running.mcpUrl).toBe(`${running.url}/mcp`);
    expect(running.healthUrl).toBe(`${running.url}/health`);

    const response = await fetch(running.healthUrl);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      protocol: { version: string; transport: string };
      persistence: { migrationVersion: number; driver: string };
      endpoints: { mcp: string; health: string };
    };
    expect(body.status).toBe("ok");
    expect(body.protocol.version).toBe("2025-11-25");
    expect(body.protocol.transport).toBe("streamable-http");
    expect(body.persistence.driver).toBe("better-sqlite3");
    expect(body.persistence.migrationVersion).toBe(1);
    expect(body.endpoints).toEqual({ mcp: "/mcp", health: "/health" });
  });

  it("cliente MCP oficial inicializa, lista tools e chama collab_status", async () => {
    const running = await startTestServer();
    const mcp = await connectTestMcpClient(running.mcpUrl);
    try {
      expect(mcp.client.getServerVersion()?.name).toBe("collab-mcp");

      const { tools } = await mcp.client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([DIAGNOSTICS_TOOL_NAME]);
      expect(tools[0]?.outputSchema).toBeDefined();

      const result = await mcp.client.callTool({
        name: DIAGNOSTICS_TOOL_NAME,
        arguments: {},
      });
      expect(result.isError).not.toBe(true);

      const report = JSON.parse(getTextContent(result)) as DiagnosticsReport;
      expect(report.status).toBe("ok");
      expect(report.protocolVersion).toBe("2025-11-25");
      expect(report.transport).toBe("streamable-http");
      expect(report.persistenceDriver).toBe("better-sqlite3");
      expect(report.migrationVersion).toBe(1);
      expect(report.appliedMigrations).toBe(1);
      expect(report.activeTransportSessions).toBeGreaterThanOrEqual(1);
      expect(result.structuredContent).toMatchObject({
        status: "ok",
        serverName: "collab-mcp",
      });
    } finally {
      await mcp.close();
    }
  });

  it("POST /mcp sem initialize e sem session id devolve 400 acionavel", async () => {
    const running = await startTestServer();
    const response = await fetch(running.mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/session/i);
  });

  it("protecao DNS rebinding rejeita Host header nao-loopback com 403", async () => {
    const running = await startTestServer();
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: running.port,
          path: "/health",
          method: "GET",
          headers: { Host: "evil.example" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });
});

describe("pontos de composicao para as proximas frentes", () => {
  it("toolModules extras sao registrados sem alterar a fundacao", async () => {
    const probeModule: ToolModule = (server) => {
      server.registerTool(
        "foundation_probe",
        { description: "Ferramenta de teste registrada por um modulo futuro." },
        () => ({ content: [{ type: "text", text: "pong" }] }),
      );
    };

    const running = await startTestServer({ toolModules: [probeModule] });
    const mcp = await connectTestMcpClient(running.mcpUrl);
    try {
      const { tools } = await mcp.client.listTools();
      expect(tools.map((tool) => tool.name)).toContain("foundation_probe");
      expect(tools.map((tool) => tool.name)).toContain(DIAGNOSTICS_TOOL_NAME);

      const result = await mcp.client.callTool({
        name: "foundation_probe",
        arguments: {},
      });
      expect(getTextContent(result)).toBe("pong");
    } finally {
      await mcp.close();
    }
  });

  it("additionalMigrations extras criam tabelas e aparecem no health", async () => {
    const extraMigration: Migration = {
      version: 2,
      name: "002_server_composition_probe",
      up(db): void {
        db.exec("CREATE TABLE server_composition_probe (id INTEGER PRIMARY KEY NOT NULL);");
      },
    };

    const running = await startTestServer({ additionalMigrations: [extraMigration] });
    expect(running.migrationResult.currentVersion).toBe(2);
    expect(running.migrationResult.applied.map((m) => m.version)).toEqual([1, 2]);

    const row = running.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("server_composition_probe");
    expect(row).toBeDefined();

    const health = (await (await fetch(running.healthUrl)).json()) as {
      persistence: { migrationVersion: number };
    };
    expect(health.persistence.migrationVersion).toBe(2);
  });
});

describe("graceful close", () => {
  it("close() encerra listener HTTP e conexao SQLite", async () => {
    const running = await startTestServer();
    const { healthUrl, database } = running;

    await running.close();

    expect(database.isOpen).toBe(false);
    await expect(fetch(healthUrl)).rejects.toThrow();
  });
});
