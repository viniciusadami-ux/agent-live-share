import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/contracts/index.js";
import { TEST_PRINCIPAL } from "../../src/server/auth/principalContext.js";
import {
  authenticateCollaborationSession,
  createCollaborationService,
  hashCollaborationSecret,
} from "../../src/collaboration/index.js";
import {
  cleanupTestRoot,
  createCollaborationFixture,
  createTestClock,
  setupRoomWithReviewer,
  type CollaborationFixture,
} from "./helpers/fixture.js";

const fixtures: CollaborationFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

afterAll(cleanupTestRoot);

function fixture(options?: Parameters<typeof createCollaborationFixture>[0]): CollaborationFixture {
  const created = createCollaborationFixture(options);
  fixtures.push(created);
  return created;
}

async function expectAsyncDomainError(
  promise: Promise<unknown>,
  code: DomainError["code"],
): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    expect((error as DomainError).hint).toBeTruthy();
    return error as DomainError;
  }
  throw new Error(`Esperava DomainError ${code}, mas a chamada resolveu.`);
}

function expectDomainError(fn: () => unknown, code: DomainError["code"]): DomainError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    expect((error as DomainError).hint).toBeTruthy();
    return error as DomainError;
  }
  throw new Error(`Esperava DomainError ${code}, mas a chamada nao lancou.`);
}

describe("criacao de sala e identidade do coordinator", () => {
  it("cria agent/participante coordinator+worker e persiste SOMENTE hash do token", async () => {
    const { service, db, clock } = fixture();
    const result = await service.createRoom({
      displayName: "OpenCode",
      clientKind: "opencode",
      roomName: "Migracao",
      workspaceId: "ws_test",
    });

    expect(result.agent.displayName).toBe("OpenCode");
    expect(result.room.workspaceId).toBe("ws_test");
    expect(result.participant.roles).toEqual(["coordinator", "worker"]);
    expect(result.participant.coordinator).toBe(true);
    expect(result.sessionToken.length).toBeGreaterThan(20);

    const actor = service.authenticate(result.sessionToken);
    expect(actor.agent.id).toBe(result.agent.id);
    expect(actor.room.id).toBe(result.room.id);
    expect(actor.isCoordinator).toBe(true);
    expect(actor.roles).toContain("coordinator");
    expect(actor.roles).toContain("worker");

    // API publica consumida pelo proximo modulo (workspace/locking).
    const publicActor = authenticateCollaborationSession(db, result.sessionToken, {
      now: clock.now,
      principalId: TEST_PRINCIPAL.id,
    });
    expect(publicActor.room.workspaceId).toBe("ws_test");
    expect(publicActor.session.id).toBe(result.session.id);
    expect(publicActor.participant.roles).toEqual(["coordinator", "worker"]);

    const sessionRow = db
      .prepare("SELECT token_hash, status FROM collab_sessions WHERE id = ?")
      .get(result.session.id);
    expect(sessionRow?.["status"]).toBe("active");
    expect(sessionRow?.["token_hash"]).toBe(hashCollaborationSecret(result.sessionToken));
    expect(sessionRow?.["token_hash"]).not.toBe(result.sessionToken);

    const dump = JSON.stringify(db.prepare("SELECT * FROM collab_sessions").all());
    expect(dump).not.toContain(result.sessionToken);
    expect(dump).toContain(hashCollaborationSecret(result.sessionToken));
  });

  it("exige workspace existente e rejeita caminhos do host", async () => {
    const { service } = fixture();

    await expectAsyncDomainError(
      service.createRoom({
        displayName: "OpenCode",
        roomName: "Sala",
        workspaceId: "ws_missing",
      }),
      "NOT_FOUND",
    );

    await expectAsyncDomainError(
      service.createRoom({
        displayName: "OpenCode",
        roomName: "Sala",
        workspaceId: "C:\\projetos\\segredo",
      }),
      "VALIDATION_FAILED",
    );

    await expectAsyncDomainError(
      service.createRoom({
        displayName: "OpenCode",
        roomName: "Sala",
        workspaceId: "../workspace",
      }),
      "VALIDATION_FAILED",
    );
  });

  it("injeção WorkspaceDirectory aceita validação assincrona", async () => {
    const { db, clock } = fixture();
    const service = createCollaborationService({
      db,
      now: clock.now,
      principalId: TEST_PRINCIPAL.id,
      workspaceDirectory: {
        async workspaceExists(workspaceId): Promise<boolean> {
          await Promise.resolve();
          return workspaceId === "ws_async";
        },
        principalCanAccess(): boolean {
          return true; // diretorio estatico de teste: sem conceito de principals
        },
      },
    });

    const room = await service.createRoom({
      displayName: "OpenCode",
      roomName: "Sala assincrona",
      workspaceId: "ws_async",
    });
    expect(room.room.workspaceId).toBe("ws_async");

    await expectAsyncDomainError(
      service.createRoom({
        displayName: "Outro",
        roomName: "Sala negada",
        workspaceId: "ws_test",
      }),
      "NOT_FOUND",
    );
  });

  it("mantem no maximo um coordinator ativo mesmo apos transferencia explicita", async () => {
    const { service, db } = fixture();
    const setup = await setupRoomWithReviewer(service, createTestClock());
    const coordinatorToken = setup.coordinatorToken;
    const workerToken = setup.workerToken;

    const countCoordinators = (): number =>
      Number(
        db
          .prepare(
            "SELECT COUNT(*) AS total FROM collab_participants WHERE room_id = ? AND coordinator_slot = 1",
          )
          .get(setup.roomId)?.["total"],
      );
    expect(countCoordinators()).toBe(1);

    // O indice UNIQUE do banco tambem impede dois slots de coordinator.
    expect(() =>
      db
        .prepare(
          "UPDATE collab_participants SET coordinator_slot = 1 WHERE room_id = ? AND agent_id = ?",
        )
        .run(setup.roomId, setup.workerAgentId),
    ).toThrow(/UNIQUE/i);

    const coordinator = service.authenticate(coordinatorToken);
    const worker = service.authenticate(workerToken);
    expect(worker.isCoordinator).toBe(false);
    expect(worker.roles).not.toContain("coordinator");
    expectDomainError(
      () => service.transferCoordinator(worker, setup.reviewerAgentId),
      "FORBIDDEN",
    );

    const transferred = service.transferCoordinator(coordinator, setup.workerAgentId);
    expect(transferred.previousCoordinatorAgentId).toBe(setup.coordinatorAgentId);
    expect(transferred.newCoordinator.agentId).toBe(setup.workerAgentId);
    expect(transferred.newCoordinator.roles).toContain("coordinator");
    expect(countCoordinators()).toBe(1);

    const oldCoordinator = service.authenticate(coordinatorToken);
    const newCoordinator = service.authenticate(workerToken);
    expect(oldCoordinator.isCoordinator).toBe(false);
    expect(oldCoordinator.roles).not.toContain("coordinator");
    expect(newCoordinator.isCoordinator).toBe(true);
    expect(newCoordinator.roles).toContain("coordinator");

    // O antigo coordinator nao pode transferir de novo; o novo pode.
    expectDomainError(
      () => service.transferCoordinator(oldCoordinator, setup.reviewerAgentId),
      "FORBIDDEN",
    );
    const state = service.getRoomState(newCoordinator);
    expect(state.coordinator.id).toBe(setup.workerAgentId);
    expect(state.participants.filter((participant) => participant.coordinator)).toHaveLength(1);
    expect(JSON.stringify(state)).not.toContain(coordinatorToken);
    expect(JSON.stringify(state)).not.toContain(workerToken);
  });

  it("join concede worker/reviewer do convite e nunca coordinator", async () => {
    const { service } = fixture();
    const room = await service.createRoom({
      displayName: "OpenCode",
      roomName: "Sala",
      workspaceId: "ws_test",
    });
    const coordinator = service.authenticate(room.sessionToken);

    const workerInvite = service.createInvite(coordinator, { reviewer: false });
    const worker = service.joinRoom({
      inviteToken: workerInvite.inviteToken,
      displayName: "Codex",
      clientKind: "codex",
    });
    expect(worker.participant.roles).toEqual(["worker"]);
    expect(worker.participant.coordinator).toBe(false);

    const reviewerInvite = service.createInvite(coordinator, { reviewer: true });
    const reviewer = service.joinRoom({
      inviteToken: reviewerInvite.inviteToken,
      displayName: "Claude Code",
      clientKind: "claude-code",
    });
    expect(reviewer.participant.roles).toEqual(["worker", "reviewer"]);
    expect(reviewer.participant.roles).not.toContain("coordinator");

    const reviewerActor = service.authenticate(reviewer.sessionToken);
    expect(reviewerActor.roles).toEqual(["worker", "reviewer"]);
    expect(reviewerActor.isCoordinator).toBe(false);
    expectDomainError(
      () => service.createInvite(reviewerActor, {}),
      "FORBIDDEN",
    );
  });
});

describe("sessoes: token, heartbeat, expiracao e revogacao", () => {
  it("rejeita token invalido e expira sessao sem heartbeat", async () => {
    const clock = createTestClock();
    const { service } = fixture({ clock });
    const room = await service.createRoom({
      displayName: "OpenCode",
      roomName: "Sala",
      workspaceId: "ws_test",
    });

    expectDomainError(() => service.authenticate("nao-e-token"), "SESSION_INACTIVE");
    expectDomainError(
      () => service.authenticate("collab_s_inventado"),
      "SESSION_INACTIVE",
    );

    clock.advance(60_001);
    const error = expectDomainError(
      () => service.authenticate(room.sessionToken),
      "SESSION_INACTIVE",
    );
    expect(error.message).toMatch(/expirada/i);
    expectDomainError(
      () => service.heartbeat(room.sessionToken),
      "SESSION_INACTIVE",
    );
  });

  it("heartbeat renova atomicamente a expiracao e nao renova sessao revogada", async () => {
    const clock = createTestClock();
    const { service, db } = fixture({ clock });
    const room = await service.createRoom({
      displayName: "OpenCode",
      roomName: "Sala",
      workspaceId: "ws_test",
    });

    clock.advance(30_000);
    const heartbeat = service.heartbeat(room.sessionToken);
    expect(heartbeat.session.expiresAt).toBe("2026-01-01T00:01:30.000Z");
    expect(heartbeat.session.lastHeartbeatAt).toBe("2026-01-01T00:00:30.000Z");

    const row = db
      .prepare("SELECT expires_at, last_heartbeat_at FROM collab_sessions WHERE id = ?")
      .get(room.session.id);
    expect(row?.["expires_at"]).toBe("2026-01-01T00:01:30.000Z");
    expect(row?.["last_heartbeat_at"]).toBe("2026-01-01T00:00:30.000Z");

    const leave = service.leave(room.sessionToken);
    expect(leave.status).toBe("revoked");
    const revokedRow = db
      .prepare("SELECT status, revoked_at FROM collab_sessions WHERE id = ?")
      .get(room.session.id);
    expect(revokedRow?.["status"]).toBe("revoked");
    expect(revokedRow?.["revoked_at"]).toBeTruthy();

    expectDomainError(
      () => service.heartbeat(room.sessionToken),
      "SESSION_INACTIVE",
    );

    expectDomainError(
      () => service.authenticate(room.sessionToken),
      "SESSION_INACTIVE",
    );
    expectDomainError(
      () => service.heartbeat(room.sessionToken),
      "SESSION_INACTIVE",
    );
  });

  it("leave revoga somente a sessao e mantem a sala/historico", async () => {
    const clock = createTestClock();
    const { service } = fixture({ clock });
    const setup = await setupRoomWithReviewer(service, clock);
    const worker = service.authenticate(setup.workerToken);

    const leave = service.leave(setup.workerToken);
    expect(leave.sessionId).toBe(worker.session.id);
    expectDomainError(
      () => service.authenticate(setup.workerToken),
      "SESSION_INACTIVE",
    );

    const coordinator = service.authenticate(setup.coordinatorToken);
    const state = service.getRoomState(coordinator);
    expect(state.participants.map((participant) => participant.agentId)).toContain(
      setup.workerAgentId,
    );
    expect(state.participants.find((p) => p.agentId === setup.workerAgentId)?.activeSessionCount).toBe(0);
  });
});

describe("convites: uso, revogacao e expiracao", () => {
  it("convite e de uso controlado e nao pode ser reutilizado alem do limite", async () => {
    const { service, db } = fixture();
    const room = await service.createRoom({
      displayName: "OpenCode",
      roomName: "Sala",
      workspaceId: "ws_test",
    });
    const coordinator = service.authenticate(room.sessionToken);
    const invite = service.createInvite(coordinator, { maxUses: 1 });

    const inviteRow = db
      .prepare("SELECT token_hash FROM collab_invites WHERE id = ?")
      .get(invite.invite.id);
    expect(inviteRow?.["token_hash"]).toBe(hashCollaborationSecret(invite.inviteToken));
    expect(inviteRow?.["token_hash"]).not.toBe(invite.inviteToken);

    service.joinRoom({ inviteToken: invite.inviteToken, displayName: "Codex" });
    expectDomainError(
      () => service.joinRoom({ inviteToken: invite.inviteToken, displayName: "Outro" }),
      "FORBIDDEN",
    );
  });

  it("convite revogado nao ingressa e revogacao e idempotente", async () => {
    const { service } = fixture();
    const room = await service.createRoom({
      displayName: "OpenCode",
      roomName: "Sala",
      workspaceId: "ws_test",
    });
    const coordinator = service.authenticate(room.sessionToken);
    const invite = service.createInvite(coordinator, {});
    const revoked = service.revokeInvite(coordinator, invite.invite.id);
    expect(revoked.status).toBe("revoked");

    expectDomainError(
      () => service.joinRoom({ inviteToken: invite.inviteToken, displayName: "Codex" }),
      "FORBIDDEN",
    );

    const again = service.revokeInvite(service.authenticate(room.sessionToken), invite.invite.id);
    expect(again.status).toBe("revoked");
    expect(again.revokedAt).toBe(revoked.revokedAt);
  });

  it("convite expirado e rejeitado com erro acionavel", async () => {
    const clock = createTestClock();
    const { service } = fixture({ clock });
    const room = await service.createRoom({
      displayName: "OpenCode",
      roomName: "Sala",
      workspaceId: "ws_test",
    });
    const coordinator = service.authenticate(room.sessionToken);
    const invite = service.createInvite(coordinator, { expiresInMinutes: 1 });
    clock.advance(61_000);
    const error = expectDomainError(
      () => service.joinRoom({ inviteToken: invite.inviteToken, displayName: "Codex" }),
      "FORBIDDEN",
    );
    expect(error.hint).toMatch(/convite/i);
  });
});

describe("persistencia apos fechar e reabrir", () => {
  it("mantem sessoes, participantes, mensagens e tarefas", async () => {
    const clock = createTestClock();
    const first = fixture({ clock });
    const setup = await setupRoomWithReviewer(first.service, clock);
    const coordinator = first.service.authenticate(setup.coordinatorToken);
    const worker = first.service.authenticate(setup.workerToken);

    const message = first.service.sendMessage(coordinator, {
      body: "Bem-vindos a sala",
    });
    expect(message.message.body).toBe("Bem-vindos a sala");
    const task = first.service.proposeTask(coordinator, {
      title: "Migrar login",
      assigneeAgentId: setup.workerAgentId,
    });
    first.service.updateTask(worker, { taskId: task.id, action: "accept" });
    const handoff = first.service.submitHandoff(worker, {
      taskId: task.id,
      objective: "Migrei login.html e login.css com testes locais.",
      changes: [{ path: "src/login.html", kind: "created" }],
      tests: [{ name: "npm test", passed: true }],
    });
    expect(handoff.taskId).toBe(task.id);

    const reopened = first.reopen();
    try {
      const coordinatorAfter = reopened.service.authenticate(setup.coordinatorToken);
      expect(coordinatorAfter.room.id).toBe(setup.roomId);
      const workerAfter = reopened.service.authenticate(setup.workerToken);
      expect(workerAfter.agent.id).toBe(setup.workerAgentId);

      const tasks = reopened.service.listTasks(coordinatorAfter);
      expect(tasks.map((item) => item.id)).toContain(task.id);
      expect(tasks.find((item) => item.id === task.id)?.status).toBe("accepted");

      const handoffs = reopened.service.listHandoffs(coordinatorAfter, { taskId: task.id });
      expect(handoffs).toHaveLength(1);
      expect(handoffs[0]?.fromAgentId).toBe(setup.workerAgentId);

      const updates = reopened.service.getUpdates(workerAfter, { cursor: "0", limit: 200 });
      expect(updates.events.some((event) => event.type === "message.sent")).toBe(true);
      expect(updates.events.some((event) => event.type === "handoff.submitted")).toBe(true);
    } finally {
      reopened.close();
    }
  });
});
