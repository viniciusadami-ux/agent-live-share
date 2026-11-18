import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { createSilentLogger } from "../../src/config/logger.js";
import {
  foundationMigrations,
  openDatabase,
  runMigrations,
  transportAuthMigrations,
} from "../../src/persistence/index.js";
import { startServer, type RunningServer } from "../../src/server/httpServer.js";
import { DIAGNOSTICS_TOOL_NAME } from "../../src/server/diagnostics.js";
import { COLLABORATION_TOOL_NAMES } from "../../src/collaboration/index.js";
import {
  CHECKPOINT_TOOL_NAMES,
  REQUIRED_ADDITIONAL_MIGRATIONS,
  WORKSPACE_TOOL_NAMES,
  createWorkspaceStack,
  type WorkspaceDefinition,
} from "../../src/workspace/index.js";
import { LOCKING_TOOL_NAMES } from "../../src/locking/index.js";
import { connectTestMcpClient, type TestMcpClient } from "../foundation/helpers/mcpClient.js";
import { cleanupTestRoot, createTestDir } from "../foundation/helpers/tmp.js";
import { issueTestCredential } from "../helpers/auth.js";

const servers: RunningServer[] = [];
const clients: TestMcpClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.close();
});
afterAll(cleanupTestRoot);

interface Envelope<T> {
  readonly ok: true;
  readonly tool: string;
  readonly data: T;
}
interface ErrorEnvelope {
  readonly ok: false;
  readonly tool: string;
  readonly error: { readonly code: string; readonly message: string; readonly hint: string };
}

function envelope<T>(result: unknown): Envelope<T> {
  return (result as { structuredContent?: unknown }).structuredContent as Envelope<T>;
}
function errorEnvelope(result: unknown): ErrorEnvelope {
  return (result as { structuredContent?: unknown }).structuredContent as ErrorEnvelope;
}
function jsonOf(result: unknown): string {
  return JSON.stringify(result);
}

async function startStack(): Promise<{ running: RunningServer; mcp: TestMcpClient; root: string }> {
  const dir = createTestDir("ws-mcp");
  const root = path.join(dir, "root");
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "login.html"), "<h1>Login</h1>\n", "utf8");
  writeFileSync(path.join(root, "shared.txt"), "v1\n", "utf8");
  const dbPath = path.join(dir, "collab.sqlite");

  // Com fail-closed, o principal precisa existir ANTES do startup para constar
  // em allowedPrincipals. Conexao curta no mesmo SQLite (migrations idempotentes).
  const setupDb = openDatabase(dbPath);
  runMigrations(setupDb, [
    ...foundationMigrations,
    ...REQUIRED_ADDITIONAL_MIGRATIONS,
    ...transportAuthMigrations,
  ]);
  const credential = issueTestCredential(setupDb, "workspace-mcp-test");
  setupDb.close();

  const definitions: readonly WorkspaceDefinition[] = [
    {
      id: "ws_test",
      name: "Workspace de teste",
      rootPath: root,
      allowedPrincipals: [credential.id],
    },
  ];
  const config = { ...loadConfig({}), port: 0, dbPath };
  const running = await startServer({
    config,
    logger: createSilentLogger(),
    additionalMigrations: REQUIRED_ADDITIONAL_MIGRATIONS,
    toolModules: [createWorkspaceStack({ definitions })],
  });
  servers.push(running);
  const mcp = await connectTestMcpClient(running.mcpUrl, credential.token);
  clients.push(mcp);
  return { running, mcp, root };
}

describe("integracao MCP HTTP real: collaboration + workspace + locking + checkpoints", () => {
  it("registra todas as tools, health e migration v30", async () => {
    const { running, mcp } = await startStack();
    const health = (await (await fetch(running.healthUrl)).json()) as {
      persistence: { migrationVersion: number };
    };
    expect(health.persistence.migrationVersion).toBe(30);
    const { tools } = await mcp.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain(DIAGNOSTICS_TOOL_NAME);
    for (const name of COLLABORATION_TOOL_NAMES) expect(names).toContain(name);
    for (const name of WORKSPACE_TOOL_NAMES) expect(names).toContain(name);
    for (const name of LOCKING_TOOL_NAMES) expect(names).toContain(name);
    for (const name of CHECKPOINT_TOOL_NAMES) expect(names).toContain(name);
  });

  it("fluxo create/join room -> read -> lock -> patch -> history -> release, sem vazar root/token", async () => {
    const { running, mcp } = await startStack();
    // Apenas respostas das NOSSAS tools (workspace/locking). As tools de
    // colaboracao create_room/join_room retornam sessionToken UMA vez por design.
    const results: unknown[] = [];

    const room = await mcp.client.callTool({
      name: "collab_create_room",
      arguments: {
        displayName: "OpenCode",
        clientKind: "opencode",
        roomName: "Migracao",
        workspaceId: "ws_test",
      },
    });
    expect(room.isError).not.toBe(true);
    const coordinatorToken = envelope<{ sessionToken: string }>(room).data.sessionToken;

    const invite = await mcp.client.callTool({
      name: "collab_create_invite",
      arguments: { token: coordinatorToken },
    });
    const inviteToken = envelope<{ inviteToken: string }>(invite).data.inviteToken;

    const join = await mcp.client.callTool({
      name: "collab_join_room",
      arguments: { inviteToken, displayName: "Codex", clientKind: "codex" },
    });
    expect(join.isError).not.toBe(true);
    const workerToken = envelope<{ sessionToken: string }>(join).data.sessionToken;

    const list = await mcp.client.callTool({
      name: "collab_list_workspaces",
      arguments: { token: coordinatorToken },
    });
    results.push(list);
    const ws = envelope<{ workspaces: Array<{ id: string; name: string }> }>(list);
    expect(ws.data.workspaces).toHaveLength(1);
    expect(Object.keys(ws.data.workspaces[0] ?? {}).sort()).toEqual(["id", "name"]);

    const read = await mcp.client.callTool({
      name: "collab_read_file",
      arguments: { token: coordinatorToken, path: "login.html" },
    });
    results.push(read);
    expect(read.isError).not.toBe(true);
    const hash = envelope<{ hash: string; content: string; version: number }>(read).data.hash;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    const lock = await mcp.client.callTool({
      name: "collab_lock_acquire",
      arguments: { token: coordinatorToken, path: "login.html", intent: "migrar login" },
    });
    results.push(lock);
    expect(lock.isError).not.toBe(true);
    const lockId = envelope<{ lock: { id: string } }>(lock).data.lock.id;

    // Worker tenta o mesmo arquivo: conflito acionavel via collab_send_message.
    const conflict = await mcp.client.callTool({
      name: "collab_lock_acquire",
      arguments: { token: workerToken, path: "login.html", intent: "revisar" },
    });
    expect(conflict.isError).toBe(true);
    expect(errorEnvelope(conflict).error.code).toBe("LOCK_ALREADY_HELD");
    expect(errorEnvelope(conflict).error.hint).toContain("collab_send_message");

    const patch = await mcp.client.callTool({
      name: "collab_apply_patch",
      arguments: {
        token: coordinatorToken,
        path: "login.html",
        lockId,
        expectedHash: hash,
        replacements: [{ oldText: "<h1>Login</h1>", newText: "<h1>Entrar</h1>" }],
      },
    });
    results.push(patch);
    expect(patch.isError).not.toBe(true);
    const patchData = envelope<{ hash: string; version: number }>(patch).data;
    expect(patchData.version).toBe(2);
    expect(String(patchData.hash)).not.toBe(hash);

    const history = await mcp.client.callTool({
      name: "collab_file_history",
      arguments: { token: coordinatorToken, path: "login.html" },
    });
    results.push(history);
    const versions = envelope<{ versions: Array<{ version: number }> }>(history).data.versions;
    expect(versions).toHaveLength(2);

    const release = await mcp.client.callTool({
      name: "collab_lock_release",
      arguments: { token: coordinatorToken, lockId },
    });
    results.push(release);
    expect(envelope<{ lock: { status: string } }>(release).data.lock.status).toBe("released");

    // Nenhuma resposta contem caminho do host, rootPath ou token de sessao.
    const all = jsonOf(results);
    expect(all).not.toContain(".tmp-tests");
    expect(all).not.toContain("rootPath");
    expect(all).not.toContain("root_realpath");
    expect(all).not.toContain(coordinatorToken);
    expect(all).not.toContain(workerToken);

    // Auditoria nao contem tokens nem root.
    const audit = JSON.stringify(
      running.database.prepare("SELECT * FROM collab_audit_log").all(),
    );
    expect(audit).toContain("collab_apply_patch");
    expect(audit).not.toContain(coordinatorToken);
    expect(audit).not.toContain(".tmp-tests");
  });

  it("TODA tool workspace/locking autentica: token invalido => SESSION_INACTIVE", async () => {
    const { mcp } = await startStack();
    for (const [name, args] of [
      ["collab_list_workspaces", {}],
      ["collab_read_file", { path: "login.html" }],
      ["collab_list_files", {}],
      ["collab_lock_list", {}],
      ["collab_checkpoint_status", {}],
      ["collab_apply_patch", { path: "login.html", lockId: "x", expectedHash: "0".repeat(64), replacements: [{ oldText: "x", newText: "y" }] }],
    ] as const) {
      const result = await mcp.client.callTool({
        name,
        arguments: { token: "token-invalido", ...(args as Record<string, unknown>) },
      });
      expect(result.isError, name).toBe(true);
      expect(errorEnvelope(result).error.code, name).toBe("SESSION_INACTIVE");
    }
  });
});
