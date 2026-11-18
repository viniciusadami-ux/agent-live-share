/**
 * Smoke test real de start/stop, executado por `npm run smoke`.
 * Sobe o servidor em porta efemera, consulta health, conecta um cliente MCP
 * oficial, chama a ferramenta de diagnostico e encerra tudo.
 */
import path from "node:path";
import { loadConfig } from "../../src/config/env.js";
import { createLogger } from "../../src/config/logger.js";
import { DIAGNOSTICS_TOOL_NAME } from "../../src/server/diagnostics.js";
import { startServer } from "../../src/server/httpServer.js";
import { connectTestMcpClient } from "./helpers/mcpClient.js";
import { cleanupTestRoot, createTestDir } from "./helpers/tmp.js";

async function main(): Promise<void> {
  const dir = createTestDir("smoke");
  const config = {
    ...loadConfig({}),
    port: 0,
    dbPath: path.join(dir, "smoke.sqlite"),
  };

  const running = await startServer({
    config,
    logger: createLogger("info"),
    transportAuth: { mode: "disabled-for-tests" },
  });
  console.log(`[smoke] listening em ${running.url} (porta efemera ${running.port})`);

  try {
    const healthResponse = await fetch(running.healthUrl);
    const health = (await healthResponse.json()) as { status: string };
    console.log(`[smoke] health HTTP ${healthResponse.status} -> ${health.status}`);
    if (healthResponse.status !== 200 || health.status !== "ok") {
      throw new Error("health nao respondeu ok");
    }

    const mcp = await connectTestMcpClient(running.mcpUrl);
    try {
      const { tools } = await mcp.client.listTools();
      console.log(`[smoke] tools: ${tools.map((tool) => tool.name).join(", ")}`);
      if (!tools.some((tool) => tool.name === DIAGNOSTICS_TOOL_NAME)) {
        throw new Error(`${DIAGNOSTICS_TOOL_NAME} nao foi registrada`);
      }

      const result = await mcp.client.callTool({
        name: DIAGNOSTICS_TOOL_NAME,
        arguments: {},
      });
      if (result.isError === true) {
        throw new Error("collab_status retornou isError");
      }
      console.log(
        `[smoke] collab_status -> ${JSON.stringify(result.structuredContent)}`,
      );
    } finally {
      await mcp.close();
    }
  } finally {
    await running.close();
    cleanupTestRoot();
  }

  console.log("[smoke] start/stop OK");
}

main().catch((error: unknown) => {
  console.error("[smoke] FALHOU:", error);
  cleanupTestRoot();
  process.exit(1);
});
