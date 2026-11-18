import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { createSilentLogger } from "../../src/config/logger.js";
import {
  COLLABORATION_TOOL_NAMES,
  collaborationMigrations,
  collaborationToolModule,
  createStaticWorkspaceDirectory,
  type HandoffView,
  type MessageView,
  type RequestView,
  type RoomStateView,
  type TaskView,
} from "../../src/collaboration/index.js";
import { DIAGNOSTICS_TOOL_NAME } from "../../src/server/diagnostics.js";
import { startServer, type RunningServer } from "../../src/server/httpServer.js";
import { connectTestMcpClient, type TestMcpClient } from "../foundation/helpers/mcpClient.js";
import { cleanupTestRoot, createTestDir } from "../foundation/helpers/tmp.js";
import { issueTestCredential } from "../helpers/auth.js";

const servers: RunningServer[] = [];
const clients: TestMcpClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

afterAll(cleanupTestRoot);

async function startCollaborationServer(): Promise<RunningServer> {
  const config = {
    ...loadConfig({}),
    port: 0,
    dbPath: path.join(createTestDir("collab-mcp"), "collaboration.sqlite"),
  };
  const running = await startServer({
    config,
    logger: createSilentLogger(),
    additionalMigrations: collaborationMigrations,
    toolModules: [
      collaborationToolModule({
        workspaceDirectory: createStaticWorkspaceDirectory(["ws_test", "ws_other"]),
      }),
    ],
  });
  servers.push(running);
  return running;
}

async function connect(running: RunningServer): Promise<TestMcpClient> {
  const credential = issueTestCredential(running.database, "collaboration-mcp-test");
  const client = await connectTestMcpClient(running.mcpUrl, credential.token);
  clients.push(client);
  return client;
}

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

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const block = content?.find((item) => item.type === "text");
  return block?.text ?? "";
}

describe("integracao MCP HTTP real do modulo de colaboracao", () => {
  it("registra collab_status + todas as tools collab_ e mantem health/migrations", async () => {
    const running = await startCollaborationServer();
    const health = (await (await fetch(running.healthUrl)).json()) as {
      persistence: { migrationVersion: number; appliedMigrations: number };
    };
    expect(health.persistence.migrationVersion).toBe(30);
    expect(health.persistence.appliedMigrations).toBe(3);

    const mcp = await connect(running);
    const { tools } = await mcp.client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain(DIAGNOSTICS_TOOL_NAME);
    for (const name of COLLABORATION_TOOL_NAMES) expect(names).toContain(name);
    expect(names).toHaveLength(COLLABORATION_TOOL_NAMES.length + 1);

    const createRoom = tools.find((tool) => tool.name === "collab_create_room");
    expect(createRoom?.outputSchema).toBeDefined();
    expect(createRoom?.inputSchema).toBeDefined();
  });

  it("fluxo completo: sala, convite, plano, tarefa, handoff e conclusao", async () => {
    const running = await startCollaborationServer();
    const mcp = await connect(running);

    const createRoom = await mcp.client.callTool({
      name: "collab_create_room",
      arguments: {
        displayName: "OpenCode",
        clientKind: "opencode",
        roomName: "Migracao de telas",
        workspaceId: "ws_test",
      },
    });
    expect(createRoom.isError).not.toBe(true);
    const roomData = envelope<{
      agent: { id: string };
      room: { id: string; workspaceId: string };
      participant: { roles: string[]; coordinator: boolean };
      session: { id: string };
      sessionToken: string;
    }>(createRoom);
    expect(roomData.ok).toBe(true);
    expect(roomData.tool).toBe("collab_create_room");
    expect(roomData.data.participant.roles).toEqual(["coordinator", "worker"]);
    expect(roomData.data.participant.coordinator).toBe(true);
    expect(roomData.data.room.workspaceId).toBe("ws_test");
    const coordinatorToken = roomData.data.sessionToken;
    const coordinatorAgentId = roomData.data.agent.id;

    const inviteResult = await mcp.client.callTool({
      name: "collab_create_invite",
      arguments: { token: coordinatorToken, reviewer: true },
    });
    expect(inviteResult.isError).not.toBe(true);
    const inviteData = envelope<{ invite: { id: string; roles: string[] }; inviteToken: string }>(
      inviteResult,
    );
    expect(inviteData.data.invite.roles).toEqual(["worker", "reviewer"]);

    const joinResult = await mcp.client.callTool({
      name: "collab_join_room",
      arguments: {
        inviteToken: inviteData.data.inviteToken,
        displayName: "Codex",
        clientKind: "codex",
      },
    });
    expect(joinResult.isError).not.toBe(true);
    const joinData = envelope<{
      agent: { id: string };
      participant: { roles: string[] };
      sessionToken: string;
    }>(joinResult);
    expect(joinData.data.participant.roles).toEqual(["worker", "reviewer"]);
    const workerToken = joinData.data.sessionToken;
    const workerAgentId = joinData.data.agent.id;

    // Worker nao pode criar convite; a negacao tambem vai para a auditoria.
    const deniedInvite = await mcp.client.callTool({
      name: "collab_create_invite",
      arguments: { token: workerToken },
    });
    expect(deniedInvite.isError).toBe(true);
    expect(errorEnvelope(deniedInvite).error.code).toBe("FORBIDDEN");

    const planRequest = await mcp.client.callTool({
      name: "collab_request_plan",
      arguments: {
        token: workerToken,
        subject: "Plano da migracao",
        details: "Dividir login e dashboard.",
      },
    });
    expect(planRequest.isError).not.toBe(true);
    const planData = envelope<{ request: RequestView; message: MessageView }>(planRequest);
    expect(planData.data.request.toAgentId).toBe(coordinatorAgentId);
    expect(planData.data.request.fromAgentId).toBe(workerAgentId);

    const answer = await mcp.client.callTool({
      name: "collab_respond_to_request",
      arguments: {
        token: coordinatorToken,
        requestId: planData.data.request.id,
        body: "OpenCode: login; Codex: dashboard.",
      },
    });
    expect(answer.isError).not.toBe(true);
    const answerData = envelope<{ request: RequestView }>(answer);
    expect(answerData.data.request.status).toBe("answered");

    const proposed = await mcp.client.callTool({
      name: "collab_propose_task",
      arguments: {
        token: coordinatorToken,
        title: "Migrar dashboard",
        description: "dashboard.html, dashboard.css e dashboard.js",
        assigneeAgentId: workerAgentId,
      },
    });
    expect(proposed.isError).not.toBe(true);
    const taskData = envelope<{ task: TaskView }>(proposed);
    expect(taskData.data.task.status).toBe("proposed");

    const accepted = await mcp.client.callTool({
      name: "collab_update_task",
      arguments: { token: workerToken, taskId: taskData.data.task.id, action: "accept" },
    });
    expect(accepted.isError).not.toBe(true);

    const started = await mcp.client.callTool({
      name: "collab_update_task",
      arguments: { token: workerToken, taskId: taskData.data.task.id, action: "start" },
    });
    expect(envelope<{ task: TaskView }>(started).data.task.status).toBe("in_progress");

    const handoff = await mcp.client.callTool({
      name: "collab_submit_handoff",
      arguments: {
        token: workerToken,
        taskId: taskData.data.task.id,
        objective: "Migrei dashboard.html, dashboard.css e dashboard.js com testes.",
        changes: [
          { path: "src/dashboard.html", kind: "created" },
          { path: "src/dashboard.css", kind: "created" },
        ],
        tests: [{ name: "npm test", passed: true }],
        decisions: ["Mantido o layout existente"],
        pending: ["Revisao visual"],
        nextStep: "Revisar com o coordinator",
        requestReview: true,
      },
    });
    expect(handoff.isError).not.toBe(true);
    const handoffData = envelope<{ handoff: HandoffView }>(handoff);
    expect(handoffData.data.handoff.reviewStatus).toBe("pending");

    const completed = await mcp.client.callTool({
      name: "collab_update_task",
      arguments: { token: workerToken, taskId: taskData.data.task.id, action: "complete" },
    });
    expect(completed.isError).not.toBe(true);
    const completedData = envelope<{ task: TaskView; handoff: HandoffView }>(completed);
    expect(completedData.data.task.status).toBe("completed");
    expect(completedData.data.handoff.fromAgentId).toBe(workerAgentId);

    const state = await mcp.client.callTool({
      name: "collab_room_state",
      arguments: { token: coordinatorToken },
    });
    const stateData = envelope<RoomStateView>(state);
    expect(stateData.data.coordinator.id).toBe(coordinatorAgentId);
    expect(stateData.data.participants).toHaveLength(2);
    expect(stateData.data.taskSummary.completed).toBe(1);

    const updates = await mcp.client.callTool({
      name: "collab_get_updates",
      arguments: { token: workerToken, cursor: "0", limit: 200 },
    });
    const updatesData = envelope<{ events: Array<{ type: string }>; nextCursor: string }>(updates);
    expect(updatesData.data.events.some((event) => event.type === "task.completed")).toBe(true);
    expect(updatesData.data.events.some((event) => event.type === "request.answered")).toBe(true);

    // Auditoria registrada no nivel das tools, sem tokens nem convites.
    const auditDump = JSON.stringify(
      running.database.prepare("SELECT * FROM collab_audit_log").all(),
    );
    expect(auditDump).toContain("collab_create_room");
    expect(auditDump).toContain("collab_join_room");
    expect(auditDump).toContain("collab_update_task");
    expect(auditDump).not.toContain(coordinatorToken);
    expect(auditDump).not.toContain(workerToken);
    expect(auditDump).not.toContain(inviteData.data.inviteToken);

    const deniedAudit = running.database
      .prepare(
        `SELECT outcome, actor_agent_id, session_id
         FROM collab_audit_log
         WHERE operation = 'collab_create_invite' AND outcome = 'denied'`,
      )
      .get();
    expect(deniedAudit?.["outcome"]).toBe("denied");
    expect(deniedAudit?.["actor_agent_id"]).toBe(workerAgentId);
    expect(deniedAudit?.["session_id"]).toBeTruthy();

    const sessionDump = JSON.stringify(
      running.database.prepare("SELECT * FROM collab_sessions").all(),
    );
    expect(sessionDump).not.toContain(coordinatorToken);
    expect(sessionDump).not.toContain(workerToken);
  });

  it("erros sao acionaveis: workspace inexistente, caminho e token invalido", async () => {
    const running = await startCollaborationServer();
    const mcp = await connect(running);

    const missingWorkspace = await mcp.client.callTool({
      name: "collab_create_room",
      arguments: { displayName: "X", roomName: "Sala", workspaceId: "ws_missing" },
    });
    expect(missingWorkspace.isError).toBe(true);
    const missing = errorEnvelope(missingWorkspace);
    expect(missing.ok).toBe(false);
    expect(missing.error.code).toBe("NOT_FOUND");
    expect(missing.error.hint).toMatch(/workspace/i);
    expect(textOf(missingWorkspace)).toContain("NOT_FOUND");

    const pathWorkspace = await mcp.client.callTool({
      name: "collab_create_room",
      arguments: { displayName: "X", roomName: "Sala", workspaceId: "C:\\segredo" },
    });
    expect(pathWorkspace.isError).toBe(true);
    expect(errorEnvelope(pathWorkspace).error.code).toBe("VALIDATION_FAILED");

    const invalidToken = await mcp.client.callTool({
      name: "collab_get_updates",
      arguments: { token: "token-invalido" },
    });
    expect(invalidToken.isError).toBe(true);
    const invalid = errorEnvelope(invalidToken);
    expect(invalid.error.code).toBe("SESSION_INACTIVE");
    expect(invalid.error.hint).toMatch(/token/i);
  });

  it("leave revoga a sessao usada pelas tools seguintes", async () => {
    const running = await startCollaborationServer();
    const mcp = await connect(running);

    const room = await mcp.client.callTool({
      name: "collab_create_room",
      arguments: { displayName: "X", roomName: "Sala", workspaceId: "ws_test" },
    });
    const token = envelope<{ sessionToken: string }>(room).data.sessionToken;

    const leave = await mcp.client.callTool({
      name: "collab_leave",
      arguments: { token },
    });
    expect(leave.isError).not.toBe(true);
    expect(envelope<{ status: string }>(leave).data.status).toBe("revoked");

    const after = await mcp.client.callTool({
      name: "collab_room_state",
      arguments: { token },
    });
    expect(after.isError).toBe(true);
    expect(errorEnvelope(after).error.code).toBe("SESSION_INACTIVE");
  });
});
