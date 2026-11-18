import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError, isDomainError } from "../../src/contracts/index.js";
import type { AuthenticatedActor } from "../../src/collaboration/index.js";
import { acquireLock } from "../../src/locking/index.js";
import {
  applyPatch,
  beginCheckpoint,
  checkpointStatus,
  endCheckpoint,
  readFile,
} from "../../src/workspace/index.js";
import {
  createWorkspaceFixture,
  cleanupTestRoot,
  type WorkspaceFixture,
} from "./helpers/fixture.js";
import {
  setupRoomWithWorker,
  setupSecondRoomSameWorkspace,
} from "./helpers/rooms.js";

let current: WorkspaceFixture;
let coordinator: AuthenticatedActor;
let worker: AuthenticatedActor;
let coordinatorToken: string;
let workerToken: string;

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return isDomainError(error) ? error.code : `NON_DOMAIN:${String(error)}`;
  }
}

function catchError(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (error) {
    if (isDomainError(error)) return error;
    throw error;
  }
  throw new Error("Esperava DomainError");
}

beforeEach(async () => {
  current = createWorkspaceFixture({ sessionTtlMs: 3_600_000 });
  const room = await setupRoomWithWorker(current.collaboration, current.clock);
  coordinatorToken = room.coordinatorToken;
  workerToken = room.workerToken;
  coordinator = current.collaboration.authenticate(coordinatorToken);
  worker = current.collaboration.authenticate(workerToken);
});
afterEach(() => {
  try {
    current.close();
  } catch {
    /* ja fechado */
  }
});
afterAll(cleanupTestRoot);

describe("checkpoints globais", () => {
  it("somente coordinator inicia; worker recebe FORBIDDEN", () => {
    expect(codeOf(() => beginCheckpoint(current.runtime, worker, { note: "x" }))).toBe(
      "FORBIDDEN",
    );
  });

  it("exige estado estavel: lock ativo no workspace => INVALID_STATE", () => {
    acquireLock(current.runtime, coordinator, { path: "login.html", intent: "editando" });
    expect(
      codeOf(() => beginCheckpoint(current.runtime, coordinator, { note: "checkpoint" })),
    ).toBe("INVALID_STATE");
  });

  it("inicia sem locks, pausa TODA mutacao e volta a permitir apos end", () => {
    const checkpoint = beginCheckpoint(current.runtime, coordinator, {
      note: "build e testes",
      testResults: { build: "ok", unit: "ok" },
    });
    expect(checkpoint.status).toBe("open");
    expect(String(checkpoint.createdByAgentId)).toBe(String(coordinator.agent.id));
    expect(checkpoint.testResults).toEqual({ build: "ok", unit: "ok" });

    const status = checkpointStatus(current.runtime, coordinator);
    expect(status.paused).toBe(true);

    // Leitura continua permitida.
    expect(readFile(current.runtime, coordinator, { path: "login.html" }).content).toContain(
      "Login",
    );

    // Locks ainda podem ser adquiridos (coordenacao), mas a MUTACAO e pausada.
    const lock = acquireLock(current.runtime, coordinator, {
      path: "login.html",
      intent: "durante checkpoint",
    });
    const read = readFile(current.runtime, coordinator, { path: "login.html" });
    const paused = catchError(() =>
      applyPatch(current.runtime, coordinator, {
        path: "login.html",
        lockId: String(lock.lock.id),
        expectedHash: String(read.hash),
        replacements: [{ oldText: "Login", newText: "Entrar" }],
      }),
    );
    expect(paused.code).toBe("CHECKPOINT_IN_PROGRESS");
    expect(paused.hint).toContain("collab_checkpoint_end");
    expect(current.readHostFile("login.html")).toBe("<h1>Login</h1>\n");

    const sealed = endCheckpoint(current.runtime, coordinator, {
      note: "testes passaram",
      testResults: { build: "ok", unit: "ok", integration: "ok" },
    });
    expect(sealed.status).toBe("sealed");
    expect(sealed.sealedAt).toBeDefined();
    expect(checkpointStatus(current.runtime, coordinator).paused).toBe(false);

    // Apos o encerramento, a mesma operacao e permitida.
    const read2 = readFile(current.runtime, coordinator, { path: "login.html" });
    applyPatch(current.runtime, coordinator, {
      path: "login.html",
      lockId: String(lock.lock.id),
      expectedHash: String(read2.hash),
      replacements: [{ oldText: "Login", newText: "Entrar" }],
    });
    expect(current.readHostFile("login.html")).toBe("<h1>Entrar</h1>\n");
  });

  it("qualquer coordinator ATUAL do mesmo workspace encerra; autoria fica registrada", async () => {
    const opened = beginCheckpoint(current.runtime, coordinator, { note: "do coordinator A" });

    // Worker da mesma sala: nao e coordinator.
    expect(codeOf(() => endCheckpoint(current.runtime, worker))).toBe("FORBIDDEN");

    // Coordinator de OUTRA sala no mesmo workspace: pode encerrar (anti-deadlock).
    const second = await setupSecondRoomSameWorkspace(
      current.collaboration,
      current.clock,
      "ws_test",
    );
    const otherCoordinator = current.collaboration.authenticate(second.coordinatorToken);
    const sealed = endCheckpoint(current.runtime, otherCoordinator);
    expect(sealed.status).toBe("sealed");
    expect(String(sealed.createdByAgentId)).toBe(String(coordinator.agent.id));
    expect(String(sealed.sealedByAgentId)).toBe(String(otherCoordinator.agent.id));

    // Evento de encerramento na sala de origem, com autor real.
    const event = current.db
      .prepare(
        `SELECT event_type, actor_agent_id, payload FROM collab_events
         WHERE event_type = 'checkpoint.sealed' ORDER BY cursor DESC LIMIT 1`,
      )
      .get();
    expect(event?.["event_type"]).toBe("checkpoint.sealed");
    expect(event?.["actor_agent_id"]).toBe(String(otherCoordinator.agent.id));
    expect(String(event?.["payload"])).toContain(String(opened.id));
  });

  it("transferencia de coordenacao NAO deixa checkpoint aberto preso (anti-deadlock)", () => {
    beginCheckpoint(current.runtime, coordinator, { note: "antes da transferencia" });

    current.collaboration.transferCoordinator(coordinator, String(worker.agent.id));
    const newCoordinator = current.collaboration.authenticate(workerToken);

    // O antigo coordinator perdeu a autoridade e nao encerra mais.
    expect(codeOf(() => endCheckpoint(current.runtime, coordinator))).toBe("FORBIDDEN");

    const sealed = endCheckpoint(current.runtime, newCoordinator);
    expect(sealed.status).toBe("sealed");
    expect(String(sealed.createdByAgentId)).toBe(String(coordinator.agent.id));
    expect(String(sealed.sealedByAgentId)).toBe(String(worker.agent.id));
    expect(checkpointStatus(current.runtime, newCoordinator).paused).toBe(false);

    // Escrita volta a funcionar apos o encerramento.
    const lock = acquireLock(current.runtime, newCoordinator, {
      path: "login.html",
      intent: "pos-checkpoint",
    });
    const read = readFile(current.runtime, newCoordinator, { path: "login.html" });
    applyPatch(current.runtime, newCoordinator, {
      path: "login.html",
      lockId: String(lock.lock.id),
      expectedHash: String(read.hash),
      replacements: [{ oldText: "Login", newText: "Entrar" }],
    });
    expect(current.readHostFile("login.html")).toBe("<h1>Entrar</h1>\n");
  });

  it("rejeita note/testResults acima dos limites (entrada defensiva)", () => {
    expect(
      codeOf(() =>
        beginCheckpoint(current.runtime, coordinator, { note: "x".repeat(4001) }),
      ),
    ).toBe("VALIDATION_FAILED");
    expect(
      codeOf(() =>
        beginCheckpoint(current.runtime, coordinator, {
          testResults: { log: "x".repeat(40_000) },
        }),
      ),
    ).toBe("VALIDATION_FAILED");
  });

  it("nao permite dois checkpoints abertos no mesmo workspace", () => {
    beginCheckpoint(current.runtime, coordinator);
    expect(codeOf(() => beginCheckpoint(current.runtime, coordinator))).toBe("ALREADY_EXISTS");
  });

  it("checkpoint e global no workspace (outra sala ve a pausa)", async () => {
    beginCheckpoint(current.runtime, coordinator, { note: "global" });
    const second = await setupSecondRoomSameWorkspace(
      current.collaboration,
      current.clock,
      "ws_test",
    );
    const other = current.collaboration.authenticate(second.coordinatorToken);
    const otherLock = acquireLock(current.runtime, other, {
      path: "login.html",
      intent: "outra sala",
    });
    const read = readFile(current.runtime, other, { path: "login.html" });
    expect(
      codeOf(() =>
        applyPatch(current.runtime, other, {
          path: "login.html",
          lockId: String(otherLock.lock.id),
          expectedHash: String(read.hash),
          replacements: [{ oldText: "Login", newText: "X" }],
        }),
      ),
    ).toBe("CHECKPOINT_IN_PROGRESS");
  });
});
