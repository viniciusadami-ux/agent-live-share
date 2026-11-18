import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { RunningApplication } from "../../src/application.js";
import { startApplication } from "../../src/application.js";
import { createSilentLogger } from "../../src/config/logger.js";
import { connectTestMcpClient, type TestMcpClient } from "../foundation/helpers/mcpClient.js";
import { cleanupTestRoot } from "../foundation/helpers/tmp.js";
import {
  callError,
  callOk,
  createIntegrationFixture,
  credentialOf,
  jsonOf,
  startIntegrationApp,
  type IntegrationFixture,
} from "./helpers/app.js";

const apps: RunningApplication[] = [];
const clients: TestMcpClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    try {
      await client.close();
    } catch {
      /* ja fechado */
    }
  }
  for (const app of apps.splice(0)) {
    try {
      await app.close();
    } catch {
      /* ja fechado */
    }
  }
});
afterAll(cleanupTestRoot);

interface Session {
  readonly fixture: IntegrationFixture;
  readonly app: RunningApplication;
  readonly a: TestMcpClient;
  readonly b: TestMcpClient;
  readonly c: TestMcpClient;
  readonly tokenA: string;
  readonly tokenB: string;
  readonly tokenC: string;
  /** Bearer tokens de TRANSPORTE (distintos dos sessionToken de sala). */
  readonly bearerA: string;
  readonly bearerB: string;
  readonly bearerC: string;
  readonly agentA: string;
  readonly agentB: string;
  readonly agentC: string;
  readonly roomId: string;
}

interface RoomData {
  readonly sessionToken: string;
  readonly agent: { readonly id: string; readonly displayName: string };
  readonly room: { readonly id: string; readonly workspaceId: string };
  readonly participant: { readonly roles: readonly string[]; readonly coordinator: boolean };
}

interface JoinData extends RoomData {
  readonly participant: { readonly roles: readonly string[]; readonly coordinator: boolean };
}

async function createSession(
  options: {
    readonly sessionTtlMs?: number;
    readonly inviteTtlMs?: number;
    readonly limits?: { readonly lockTtlMs?: number };
  } = {},
): Promise<Session> {
  const fixture = createIntegrationFixture();
  const app = await startIntegrationApp(fixture, options);
  apps.push(app);

  const credentialA = credentialOf(fixture, 0);
  const credentialB = credentialOf(fixture, 1);
  const credentialC = credentialOf(fixture, 2);

  const a = await connectTestMcpClient(app.mcpUrl, credentialA.token);
  const b = await connectTestMcpClient(app.mcpUrl, credentialB.token);
  const c = await connectTestMcpClient(app.mcpUrl, credentialC.token);
  clients.push(a, b, c);

  const room = await callOk<RoomData>(a, "collab_create_room", {
    displayName: "OpenCode",
    clientKind: "opencode",
    roomName: "Migracao",
    workspaceId: "ws_integration",
  });
  const workerInvite = await callOk<{ inviteToken: string }>(a, "collab_create_invite", {
    token: room.sessionToken,
  });
  const worker = await callOk<JoinData>(b, "collab_join_room", {
    inviteToken: workerInvite.inviteToken,
    displayName: "Codex",
    clientKind: "codex",
  });
  const reviewerInvite = await callOk<{ inviteToken: string }>(a, "collab_create_invite", {
    token: room.sessionToken,
    reviewer: true,
  });
  const reviewer = await callOk<JoinData>(c, "collab_join_room", {
    inviteToken: reviewerInvite.inviteToken,
    displayName: "Claude Code",
    clientKind: "claude-code",
  });

  return {
    fixture,
    app,
    a,
    b,
    c,
    tokenA: room.sessionToken,
    tokenB: worker.sessionToken,
    tokenC: reviewer.sessionToken,
    bearerA: credentialA.token,
    bearerB: credentialB.token,
    bearerC: credentialC.token,
    agentA: room.agent.id,
    agentB: worker.agent.id,
    agentC: reviewer.agent.id,
    roomId: room.room.id,
  };
}

interface UpdatesData {
  readonly events: ReadonlyArray<{
    readonly type: string;
    readonly payload: { readonly body?: string; readonly [key: string]: unknown };
  }>;
  readonly nextCursor: string;
}

function hasBody(data: UpdatesData, body: string): boolean {
  return data.events.some((event) => event.payload.body === body);
}

interface ReadData {
  readonly content: string;
  readonly hash: string;
  readonly version: number;
}

interface LockData {
  readonly reacquired: boolean;
  readonly lock: { readonly id: string; readonly status: string; readonly agentId: string };
}

interface HistoryData {
  readonly versions: ReadonlyArray<{
    readonly version: number;
    readonly createdByAgentId?: string;
    readonly kind: string;
  }>;
}

interface TaskData {
  readonly task: { readonly id: string; readonly status: string };
}

interface CheckpointData {
  readonly checkpoint: {
    readonly id: string;
    readonly status: string;
    readonly createdByAgentId: string;
    readonly sealedByAgentId?: string;
  };
}

describe("integracao multicliente com dois/três clientes MCP e o mesmo SQLite", () => {
  it("identidades, papeis e isolamento de sessao/token entre conexoes", async () => {
    const s = await createSession();
    expect(s.tokenA).not.toBe(s.tokenB);
    expect(s.tokenB).not.toBe(s.tokenC);
    expect(s.agentA).not.toBe(s.agentB);
    expect(s.agentB).not.toBe(s.agentC);

    const stateA = await callOk<{
      self: { agent: { id: string }; roles: string[] };
      coordinator: { id: string };
      participants: Array<{ agentId: string; roles: string[] }>;
    }>(s.a, "collab_room_state", { token: s.tokenA });
    const stateB = await callOk<{
      self: { agent: { id: string }; roles: string[] };
      coordinator: { id: string };
    }>(s.b, "collab_room_state", { token: s.tokenB });
    const stateC = await callOk<{
      self: { agent: { id: string }; roles: string[] };
    }>(s.c, "collab_room_state", { token: s.tokenC });

    expect(stateA.self.agent.id).toBe(s.agentA);
    expect(stateA.coordinator.id).toBe(s.agentA);
    expect(stateB.self.agent.id).toBe(s.agentB);
    expect(stateC.self.agent.id).toBe(s.agentC);
    expect(stateB.self.roles).toEqual(["worker"]);
    expect(stateC.self.roles).toEqual(["worker", "reviewer"]);
    expect(stateA.participants).toHaveLength(3);

    // Worker/reviewer nao podem executar operacoes de coordinator.
    expect(
      (await callError(s.b, "collab_create_invite", { token: s.tokenB })).error.code,
    ).toBe("FORBIDDEN");
    expect(
      (await callError(s.c, "collab_create_invite", { token: s.tokenC })).error.code,
    ).toBe("FORBIDDEN");

    // Token de A nao e aceito como identidade de B em parametro algum:
    // as tools derivam agente/sala do token; B continua sendo B.
    const taskForA = await callOk<TaskData>(s.a, "collab_propose_task", {
      token: s.tokenA,
      title: "Tarefa do coordinator",
      assigneeAgentId: s.agentA,
    });
    const denied = await callError(s.b, "collab_update_task", {
      token: s.tokenB,
      taskId: taskForA.task.id,
      action: "accept",
    });
    expect(denied.error.code).toBe("FORBIDDEN");
    expect(denied.error.hint).toMatch(/atribu/i);

    // Nenhuma resposta de estado/sessao contem token ou caminho do host.
    const serialized = jsonOf([stateA, stateB, stateC]);
    expect(serialized).not.toContain(s.tokenA);
    expect(serialized).not.toContain(s.tokenB);
    expect(serialized).not.toContain(s.fixture.root);
  });

  it("plan request, resposta e mensagens diretas isoladas de terceiros", async () => {
    const s = await createSession();

    const request = await callOk<{
      request: { id: string; subject: string; status: string };
      message: { id: string };
    }>(s.b, "collab_request_plan", {
      token: s.tokenB,
      subject: "Plano da migracao",
      details: "Dividir login e dashboard.",
    });
    expect(request.request.status).toBe("open");

    const aUpdates = await callOk<UpdatesData>(s.a, "collab_get_updates", {
      token: s.tokenA,
      cursor: "0",
      limit: 200,
    });
    expect(aUpdates.events.some((event) => event.type === "request.created")).toBe(true);
    expect(hasBody(aUpdates, "Plano da migracao\n\nDividir login e dashboard.")).toBe(true);

    const answer = await callOk<{ request: { status: string } }>(
      s.a,
      "collab_respond_to_request",
      {
        token: s.tokenA,
        requestId: request.request.id,
        body: "OpenCode: login; Codex: dashboard.",
      },
    );
    expect(answer.request.status).toBe("answered");

    const bUpdates = await callOk<UpdatesData>(s.b, "collab_get_updates", {
      token: s.tokenB,
      cursor: "0",
      limit: 200,
    });
    expect(bUpdates.events.some((event) => event.type === "request.answered")).toBe(true);
    expect(hasBody(bUpdates, "OpenCode: login; Codex: dashboard.")).toBe(true);

    const directBody = "B->A: preciso do login.html";
    await callOk(s.b, "collab_send_message", {
      token: s.tokenB,
      toAgentId: s.agentA,
      body: directBody,
    });

    const aDirect = await callOk<UpdatesData>(s.a, "collab_get_updates", {
      token: s.tokenA,
      cursor: "0",
      limit: 200,
    });
    expect(hasBody(aDirect, directBody)).toBe(true);

    const cDirect = await callOk<UpdatesData>(s.c, "collab_get_updates", {
      token: s.tokenC,
      cursor: "0",
      limit: 200,
    });
    expect(hasBody(cDirect, directBody)).toBe(false);

    const roomBody = "Aviso da sala: checkpoint em breve";
    await callOk(s.a, "collab_send_message", { token: s.tokenA, body: roomBody });
    const cRoom = await callOk<UpdatesData>(s.c, "collab_get_updates", {
      token: s.tokenC,
      cursor: "0",
      limit: 200,
    });
    expect(hasBody(cRoom, roomBody)).toBe(true);
  });

  it("mesmo arquivo, conflito de lock, negociacao, patch e hash antigo rejeitado", async () => {
    const s = await createSession();

    const readA = await callOk<ReadData>(s.a, "collab_read_file", {
      token: s.tokenA,
      path: "login.html",
    });
    const readB = await callOk<ReadData>(s.b, "collab_read_file", {
      token: s.tokenB,
      path: "login.html",
    });
    expect(readB.content).toBe(readA.content);
    expect(readB.hash).toBe(readA.hash);

    const lockA = await callOk<LockData>(s.a, "collab_lock_acquire", {
      token: s.tokenA,
      path: "login.html",
      intent: "migrar login",
    });
    expect(lockA.lock.status).toBe("held");
    expect(lockA.lock.agentId).toBe(s.agentA);

    const conflict = await callError(s.b, "collab_lock_acquire", {
      token: s.tokenB,
      path: "login.html",
      intent: "revisar login",
    });
    expect(conflict.error.code).toBe("LOCK_ALREADY_HELD");
    expect(conflict.error.hint).toContain("collab_send_message");
    expect(conflict.error.hint).toContain("OpenCode");

    const deniedWrite = await callError(s.b, "collab_apply_patch", {
      token: s.tokenB,
      path: "login.html",
      lockId: lockA.lock.id,
      expectedHash: readA.hash,
      replacements: [{ oldText: "<h1>Login</h1>", newText: "<h1>Codex</h1>" }],
    });
    expect(deniedWrite.error.code).toBe("FORBIDDEN");

    const negotiation = "OpenCode, libere login.html quando terminar; preciso ajustar o CSS.";
    await callOk(s.b, "collab_send_message", {
      token: s.tokenB,
      toAgentId: s.agentA,
      body: negotiation,
    });
    const aUpdates = await callOk<UpdatesData>(s.a, "collab_get_updates", {
      token: s.tokenA,
      cursor: "0",
      limit: 200,
    });
    expect(hasBody(aUpdates, negotiation)).toBe(true);

    const patchA = await callOk<{ version: number; hash: string }>(
      s.a,
      "collab_apply_patch",
      {
        token: s.tokenA,
        path: "login.html",
        lockId: lockA.lock.id,
        expectedHash: readA.hash,
        replacements: [{ oldText: "<h1>Login</h1>", newText: "<h1>Entrar</h1>" }],
      },
    );
    expect(patchA.version).toBe(2);

    await callOk(s.a, "collab_lock_release", { token: s.tokenA, lockId: lockA.lock.id });

    const lockB = await callOk<LockData>(s.b, "collab_lock_acquire", {
      token: s.tokenB,
      path: "login.html",
      intent: "ajustar CSS",
    });
    const readAfter = await callOk<ReadData>(s.b, "collab_read_file", {
      token: s.tokenB,
      path: "login.html",
    });
    expect(readAfter.content).toBe("<h1>Entrar</h1>\n");
    expect(readAfter.hash).not.toBe(readA.hash);

    const stale = await callError(s.b, "collab_apply_patch", {
      token: s.tokenB,
      path: "login.html",
      lockId: lockB.lock.id,
      expectedHash: readA.hash,
      replacements: [{ oldText: "Entrar", newText: "Login" }],
    });
    expect(stale.error.code).toBe("HASH_MISMATCH");
    expect(stale.error.hint).toMatch(/releia/i);

    const patchB = await callOk<{ version: number }>(s.b, "collab_apply_patch", {
      token: s.tokenB,
      path: "login.html",
      lockId: lockB.lock.id,
      expectedHash: readAfter.hash,
      replacements: [{ oldText: "<h1>Entrar</h1>", newText: "<h1>Entrar (Codex)</h1>" }],
    });
    expect(patchB.version).toBe(3);
    await callOk(s.b, "collab_lock_release", { token: s.tokenB, lockId: lockB.lock.id });

    const history = await callOk<HistoryData>(s.a, "collab_file_history", {
      token: s.tokenA,
      path: "login.html",
    });
    expect(history.versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(history.versions.find((v) => v.version === 2)?.createdByAgentId).toBe(s.agentA);
    expect(history.versions.find((v) => v.version === 3)?.createdByAgentId).toBe(s.agentB);

    const finalRead = await callOk<ReadData>(s.a, "collab_read_file", {
      token: s.tokenA,
      path: "login.html",
    });
    expect(finalRead.content).toBe("<h1>Entrar (Codex)</h1>\n");
  });

  it("tarefa/handoff, checkpoint pausa escrita e transferencia de coordinator nao gera deadlock", async () => {
    const s = await createSession();

    const task = await callOk<TaskData>(s.a, "collab_propose_task", {
      token: s.tokenA,
      title: "Migrar dashboard",
      assigneeAgentId: s.agentB,
    });
    expect((await callOk<TaskData>(s.b, "collab_update_task", {
      token: s.tokenB,
      taskId: task.task.id,
      action: "accept",
    })).task.status).toBe("accepted");
    expect((await callOk<TaskData>(s.b, "collab_update_task", {
      token: s.tokenB,
      taskId: task.task.id,
      action: "start",
    })).task.status).toBe("in_progress");
    await callOk(s.b, "collab_submit_handoff", {
      token: s.tokenB,
      taskId: task.task.id,
      objective: "Migrei dashboard.html e dashboard.css com testes locais.",
      changes: [{ path: "src/dashboard.html", kind: "created" }],
      tests: [{ name: "npm test", passed: true }],
    });
    const completed = await callOk<TaskData>(s.b, "collab_update_task", {
      token: s.tokenB,
      taskId: task.task.id,
      action: "complete",
    });
    expect(completed.task.status).toBe("completed");

    const checkpoint = await callOk<CheckpointData>(s.a, "collab_checkpoint_begin", {
      token: s.tokenA,
      note: "build/testes",
      testResults: { build: "ok", unit: "ok" },
    });
    expect(checkpoint.checkpoint.status).toBe("open");

    const readShared = await callOk<ReadData>(s.b, "collab_read_file", {
      token: s.tokenB,
      path: "shared.txt",
    });
    const lockShared = await callOk<LockData>(s.b, "collab_lock_acquire", {
      token: s.tokenB,
      path: "shared.txt",
      intent: "editar durante checkpoint",
    });
    const paused = await callError(s.b, "collab_apply_patch", {
      token: s.tokenB,
      path: "shared.txt",
      lockId: lockShared.lock.id,
      expectedHash: readShared.hash,
      replacements: [{ oldText: "v1", newText: "v2" }],
    });
    expect(paused.error.code).toBe("CHECKPOINT_IN_PROGRESS");

    await callOk(s.a, "collab_transfer_coordinator", {
      token: s.tokenA,
      targetAgentId: s.agentB,
    });

    // Criador transferiu a coordenacao: nao pode mais encerrar (nao e coordinator).
    expect(
      (await callError(s.a, "collab_checkpoint_end", { token: s.tokenA })).error.code,
    ).toBe("FORBIDDEN");

    // Coordinator ATUAL (B) encerra e autoria fica correta.
    const sealed = await callOk<CheckpointData>(s.b, "collab_checkpoint_end", {
      token: s.tokenB,
      note: "testes passaram",
      testResults: { build: "ok", unit: "ok", integration: "ok" },
    });
    expect(sealed.checkpoint.status).toBe("sealed");
    expect(sealed.checkpoint.createdByAgentId).toBe(s.agentA);
    expect(sealed.checkpoint.sealedByAgentId).toBe(s.agentB);

    // Pausa encerrada: B grava com o lock que ja possuia.
    const patch = await callOk<{ version: number }>(s.b, "collab_apply_patch", {
      token: s.tokenB,
      path: "shared.txt",
      lockId: lockShared.lock.id,
      expectedHash: readShared.hash,
      replacements: [{ oldText: "v1", newText: "v2" }],
    });
    expect(patch.version).toBe(2);
    await callOk(s.b, "collab_lock_release", {
      token: s.tokenB,
      lockId: lockShared.lock.id,
    });

    // Reinicio com o MESMO SQLite/workspace: dados, autores e arquivo sobrevivem.
    const before = {
      tasks: await callOk<{ tasks: TaskData["task"][] }>(s.b, "collab_list_tasks", {
        token: s.tokenB,
        limit: 200,
      }),
      history: await callOk<HistoryData>(s.b, "collab_file_history", {
        token: s.tokenB,
        path: "shared.txt",
      }),
      updates: await callOk<UpdatesData>(s.b, "collab_get_updates", {
        token: s.tokenB,
        cursor: "0",
        limit: 200,
      }),
    };

    for (const client of [s.a, s.b, s.c]) {
      await client.close();
      const index = clients.indexOf(client);
      if (index >= 0) clients.splice(index, 1);
    }
    await s.app.close();
    const appIndex = apps.indexOf(s.app);
    if (appIndex >= 0) apps.splice(appIndex, 1);

    const restarted = await startApplication({
      config: s.fixture.config,
      definitions: s.fixture.definitions,
      logger: createSilentLogger(),
      now: s.fixture.clock.now,
      sessionTtlMs: 3_600_000,
      inviteTtlMs: 3_600_000,
    });
    apps.push(restarted);
    expect(restarted.migrationResult.currentVersion).toBe(30);
    expect(restarted.migrationResult.applied).toEqual([]);

    // Principals persistem no mesmo SQLite: a credencial B continua valida.
    const bAgain = await connectTestMcpClient(restarted.mcpUrl, s.bearerB);
    clients.push(bAgain);
    const state = await callOk<{
      self: { agent: { id: string } };
      coordinator: { id: string };
      participants: unknown[];
    }>(bAgain, "collab_room_state", { token: s.tokenB });
    expect(state.self.agent.id).toBe(s.agentB);
    expect(state.coordinator.id).toBe(s.agentB);
    expect(state.participants).toHaveLength(3);

    const tasksAfter = await callOk<{ tasks: Array<{ status: string }> }>(
      bAgain,
      "collab_list_tasks",
      { token: s.tokenB, limit: 200 },
    );
    expect(tasksAfter.tasks).toHaveLength(before.tasks.tasks.length);
    expect(tasksAfter.tasks.some((item) => item.status === "completed")).toBe(true);

    const historyAfter = await callOk<HistoryData>(bAgain, "collab_file_history", {
      token: s.tokenB,
      path: "shared.txt",
    });
    expect(historyAfter.versions).toHaveLength(before.history.versions.length);
    expect(historyAfter.versions.find((v) => v.version === 2)?.createdByAgentId).toBe(
      s.agentB,
    );

    const updatesAfter = await callOk<UpdatesData>(bAgain, "collab_get_updates", {
      token: s.tokenB,
      cursor: "0",
      limit: 200,
    });
    expect(updatesAfter.events.length).toBeGreaterThanOrEqual(before.updates.events.length);
    expect(updatesAfter.events.some((event) => event.type === "checkpoint.sealed")).toBe(true);

    const file = await callOk<ReadData>(bAgain, "collab_read_file", {
      token: s.tokenB,
      path: "shared.txt",
    });
    expect(file.content).toBe("v2\n");
    expect(
      Number(
        restarted.database
          .prepare("SELECT COUNT(*) AS total FROM file_pending_writes")
          .get()?.["total"],
      ),
    ).toBe(0);
  });

  it("expiracao de lock e sessao com clock injetavel", async () => {
    const s = await createSession({ sessionTtlMs: 60_000, limits: { lockTtlMs: 1000 } });

    const lockA = await callOk<LockData>(s.a, "collab_lock_acquire", {
      token: s.tokenA,
      path: "shared.txt",
      intent: "vou abandonar",
    });
    s.fixture.clock.advance(2_000);
    const lockB = await callOk<LockData>(s.b, "collab_lock_acquire", {
      token: s.tokenB,
      path: "shared.txt",
      intent: "assumir apos expiracao",
    });
    expect(lockB.reacquired).toBe(false);
    expect(lockB.lock.id).not.toBe(lockA.lock.id);

    // Heartbeat renova a sessao; depois do TTL sem heartbeat, A e recusado.
    await callOk(s.a, "collab_heartbeat", { token: s.tokenA });
    s.fixture.clock.advance(61_000);
    expect(
      (await callError(s.a, "collab_room_state", { token: s.tokenA })).error.code,
    ).toBe("SESSION_INACTIVE");
  });
});
