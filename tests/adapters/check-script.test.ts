import { spawn } from "node:child_process";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { createSilentLogger } from "../../src/config/logger.js";
import { startApplication, type RunningApplication } from "../../src/application.js";
import { createPrincipal } from "../../src/server/auth/principals.js";
import {
  checkMcpConnection,
  redactToken,
} from "../../adapters/scripts/check-mcp-connection.js";
import { cleanupTestRoot, createTestDir } from "../foundation/helpers/tmp.js";

let running: RunningApplication | undefined;

function runCheckCli(
  env: Readonly<Record<string, string>>,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  const root = process.cwd();
  const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const script = path.join(root, "adapters", "scripts", "check-mcp-connection.ts");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, script], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

afterAll(async () => {
  await running?.close();
  cleanupTestRoot();
});

describe("check:mcp contra aplicacao real em porta efemera", () => {
  it("conecta com Bearer, lista 37 tools e chama collab_status sem vazar token", async () => {
    const config = {
      ...loadConfig({}),
      port: 0,
      dbPath: path.join(createTestDir("adapter-check"), "adapter-check.sqlite"),
    };
    running = await startApplication({
      config,
      logger: createSilentLogger(),
      definitions: [],
    });

    const { principal, token } = createPrincipal(running.database, "adapter-check");
    const result = await checkMcpConnection({
      url: running.mcpUrl,
      bearerToken: token,
    });

    expect(result.status).toBe("ok");
    expect(result.toolCount).toBe(37);
    expect(result.toolNames).toContain("collab_status");
    expect(result.toolNames).toContain("collab_create_room");
    expect(result.toolNames).toContain("collab_apply_patch");
    expect(result.toolNames).toContain("collab_lock_acquire");
    expect(result.principalId).toBe(principal.id);
    expect(result.principalName).toBe("adapter-check");
    expect(result.protocolVersion).toBe("2025-11-25");

    const dumped = JSON.stringify(result);
    expect(dumped).not.toContain(token);
  });

  it("CLI npm script conecta, lista 37 tools e nao imprime o token", async () => {
    expect(running).toBeDefined();
    const { token } = createPrincipal(running!.database, "adapter-check-cli");
    const result = await runCheckCli({
      COLLAB_MCP_URL: running!.mcpUrl,
      COLLAB_MCP_BEARER: token,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("37 tools");
    expect(result.stdout).toContain("collab_status OK");
    expect(result.stdout).toContain("adapter-check-cli");
    expect(result.stdout).not.toContain(token);
    expect(result.stderr).not.toContain(token);
  });

  it("token invalido falha com erro sanitizado e sem ecoar o token", async () => {
    expect(running).toBeDefined();
    const token = "invalid-token-for-test";
    let message = "";
    try {
      await checkMcpConnection({
        url: running!.mcpUrl,
        bearerToken: token,
      });
      throw new Error("esperava falha de autenticacao");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(token);
    expect(message).toMatch(/401|unauthorized|HTTP/i);
    expect(redactToken(`prefix ${token} suffix`, token)).toBe(
      "prefix [redacted] suffix",
    );
  });
});
