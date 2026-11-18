import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { startApplication, type RunningApplication } from "../../src/application.js";
import { loadConfig } from "../../src/config/env.js";
import { createSilentLogger } from "../../src/config/logger.js";
import { readMigrationRecords } from "../../src/persistence/index.js";
import { COLLABORATION_TOOL_NAMES } from "../../src/collaboration/index.js";
import { DIAGNOSTICS_TOOL_NAME } from "../../src/server/diagnostics.js";
import {
  CHECKPOINT_TOOL_NAMES,
  WORKSPACE_TOOL_NAMES,
} from "../../src/workspace/index.js";
import { LOCKING_TOOL_NAMES } from "../../src/locking/index.js";
import { connectTestMcpClient, type TestMcpClient } from "../foundation/helpers/mcpClient.js";
import { cleanupTestRoot } from "../foundation/helpers/tmp.js";
import {
  callError,
  callOk,
  createIntegrationFixture,
  credentialOf,
  startIntegrationApp,
  type ErrorEnvelope,
} from "./helpers/app.js";
import type { TestCredential } from "../helpers/auth.js";

const apps: RunningApplication[] = [];
const clients: TestMcpClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const app of apps.splice(0)) await app.close();
});
afterAll(cleanupTestRoot);

async function connect(
  app: RunningApplication,
  credential: TestCredential,
): Promise<TestMcpClient> {
  return connectTestMcpClient(app.mcpUrl, credential.token);
}

const EXPECTED_TOOLS = [
  DIAGNOSTICS_TOOL_NAME,
  ...COLLABORATION_TOOL_NAMES,
  ...WORKSPACE_TOOL_NAMES,
  ...LOCKING_TOOL_NAMES,
  ...CHECKPOINT_TOOL_NAMES,
] as const;

describe("aplicacao integrada (entrypoint real)", () => {
  it("health mostra migration v30/auth habilitada e lista exatamente 37 tools sem roots/tokens", async () => {
    const fixture = createIntegrationFixture();
    const app = await startIntegrationApp(fixture);
    apps.push(app);
    expect(app.workspaceCount).toBe(1);
    expect(app.workspaceIds).toEqual(["ws_integration"]);
    expect(app.migrationResult.currentVersion).toBe(30);
    // A fixture pre-aplica as migrations para emitir credenciais antes do
    // startup; conferimos o ESTADO persistido, nao o que foi aplicado nesta run.
    expect(readMigrationRecords(app.database).map((m) => m.version)).toEqual([
      1, 2, 10, 20, 30,
    ]);
    expect(app.migrationResult.totalApplied).toBe(5);
    expect(app.authEnabled).toBe(true);

    const healthResponse = await fetch(app.healthUrl);
    expect(healthResponse.status).toBe(200);
    const health = (await healthResponse.json()) as {
      status: string;
      auth: { enabled: boolean };
      persistence: { migrationVersion: number; appliedMigrations: number };
    };
    expect(health.status).toBe("ok");
    expect(health.auth.enabled).toBe(true);
    expect(health.persistence.migrationVersion).toBe(30);
    expect(health.persistence.appliedMigrations).toBe(5);
    const healthText = JSON.stringify(health);
    expect(healthText).not.toContain(fixture.root);
    expect(healthText).not.toContain("rootPath");
    expect(healthText).not.toContain("token");

    const mcp = await connect(app, credentialOf(fixture, 0));
    clients.push(mcp);
    const { tools } = await mcp.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    expect(tools).toHaveLength(37);

    const status = await mcp.client.callTool({
      name: DIAGNOSTICS_TOOL_NAME,
      arguments: {},
    });
    const statusText = JSON.stringify(status);
    expect(statusText).not.toContain(fixture.root);
    expect(statusText).not.toContain(fixture.dbPath);
    expect(statusText).not.toContain("persistencePath");
  });

  it("sem arquivo de workspaces: sobe com catalogo vazio e create_room e recusado", async () => {
    const fixture = createIntegrationFixture();
    const app = await startApplication({
      config: fixture.config,
      cwd: fixture.dir,
      env: {},
      logger: createSilentLogger(),
      now: fixture.clock.now,
    });
    apps.push(app);
    expect(app.workspaceCount).toBe(0);
    expect(app.workspaceSource).toBe("empty");

    const mcp = await connect(app, credentialOf(fixture, 0));
    clients.push(mcp);
    const error = await callError(mcp, "collab_create_room", {
      displayName: "OpenCode",
      roomName: "Sala",
      workspaceId: "ws_integration",
    });
    // Fail-closed: sem allowedPrincipals nao ha como distinguir workspace
    // inexistente de nao autorizado; o erro e o mesmo FORBIDDEN generico.
    expect((error as ErrorEnvelope).error.code).toBe("FORBIDDEN");
    expect((error as ErrorEnvelope).error.hint).toMatch(/workspace/i);
  });

  it("COLLAB_WORKSPACES_FILE registra o workspace e create_room passa a funcionar", async () => {
    const fixture = createIntegrationFixture();
    writeFileSync(
      path.join(fixture.dir, "workspaces.json"),
      JSON.stringify({
        workspaces: [
          {
            id: "ws_integration",
            name: "Fixture",
            rootPath: "./root",
            // Lista EXATA: sem isso o workspace fica fail-closed (ninguem autorizado).
            allowedPrincipals: [credentialOf(fixture, 0).id],
          },
        ],
      }),
      "utf8",
    );

    const app = await startApplication({
      config: fixture.config,
      cwd: fixture.dir,
      env: { COLLAB_WORKSPACES_FILE: "workspaces.json" },
      logger: createSilentLogger(),
      now: fixture.clock.now,
    });
    apps.push(app);
    expect(app.workspaceCount).toBe(1);
    expect(app.workspaceSource).toBe("file");

    const mcp = await connect(app, credentialOf(fixture, 0));
    clients.push(mcp);
    const room = await callOk<{ sessionToken: string; room: { workspaceId: string } }>(
      mcp,
      "collab_create_room",
      {
        displayName: "OpenCode",
        roomName: "Sala",
        workspaceId: "ws_integration",
      },
    );
    expect(room.room.workspaceId).toBe("ws_integration");
    expect(room.sessionToken).toMatch(/^collab_s_/);

    const file = await callOk<{ content: string; hash: string }>(mcp, "collab_read_file", {
      token: room.sessionToken,
      path: "login.html",
    });
    expect(file.content).toBe("<h1>Login</h1>\n");
    expect(file.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("root invalido na config falha no startup (fail-fast), sem subir meio configurado", async () => {
    const fixture = createIntegrationFixture();
    await expect(
      startApplication({
        config: fixture.config,
        definitions: [
          { id: "ws_bad", name: "Bad", rootPath: path.join(fixture.dir, "nao-existe") },
        ],
        logger: createSilentLogger(),
      }),
    ).rejects.toThrow(/workspaces/i);
  });
});
