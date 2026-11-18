import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError, isDomainError } from "../../src/contracts/index.js";
import type { AuthenticatedActor } from "../../src/collaboration/index.js";
import {
  acquireLock,
  assertUsableLock,
  lockList,
  lockStatus,
  releaseLock,
  renewLock,
} from "../../src/locking/index.js";
import {
  createWorkspaceFixture,
  cleanupTestRoot,
  type WorkspaceFixture,
} from "../workspace/helpers/fixture.js";
import {
  setupRoomWithWorker,
  setupSecondRoomSameWorkspace,
} from "../workspace/helpers/rooms.js";

let current: WorkspaceFixture;
let coordinator: AuthenticatedActor;
let worker: AuthenticatedActor;

beforeEach(async () => {
  current = createWorkspaceFixture({
    sessionTtlMs: 3_600_000,
    limits: { lockTtlMs: 1000 },
  });
  const room = await setupRoomWithWorker(current.collaboration, current.clock);
  coordinator = current.collaboration.authenticate(room.coordinatorToken);
  worker = current.collaboration.authenticate(room.workerToken);
});
afterEach(() => {
  try {
    current.close();
  } catch {
    /* ja fechado */
  }
});
afterAll(cleanupTestRoot);

function catchError(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (error) {
    if (isDomainError(error)) return error;
    throw error;
  }
  throw new Error("Esperava DomainError, mas nenhum erro foi lancado.");
}

describe("locks exclusivos: disputa, conflito acionavel, release, renew, expiry", () => {
  it("dois agentes na MESMA sala: so um lock; conflito com dono/intencao/expiracao", () => {
    const first = acquireLock(current.runtime, coordinator, {
      path: "login.html",
      intent: "migrar login para HTML",
    });
    expect(first.reacquired).toBe(false);
    expect(first.lock.status).toBe("held");
    expect(first.lock.agentDisplayName).toBe("OpenCode");

    const conflict = catchError(() =>
      acquireLock(current.runtime, worker, {
        path: "login.html",
        intent: "revisar login",
      }),
    );
    expect(conflict.code).toBe("LOCK_ALREADY_HELD");
    expect(conflict.hint).toContain("collab_send_message");
    expect(conflict.message).toContain("OpenCode");
    expect(conflict.context).toMatchObject({
      ownerDisplayName: "OpenCode",
      intent: "migrar login para HTML",
    });
    expect(String(conflict.context?.["expiresAt"])).toMatch(/\d{4}-/);
    // Nenhum root/token vaza.
    expect(JSON.stringify(conflict.context)).not.toContain(current.root);
  });

  it("release pelo dono libera e outro agente adquire; renovacao estende o TTL", () => {
    const first = acquireLock(current.runtime, coordinator, {
      path: "login.html",
      intent: "trabalho A",
    });
    releaseLock(current.runtime, coordinator, { lockId: String(first.lock.id) });

    const second = acquireLock(current.runtime, worker, {
      path: "login.html",
      intent: "trabalho B",
    });
    expect(second.reacquired).toBe(false);
    expect(String(second.lock.agentId)).toBe(String(worker.agent.id));

    const before = Date.parse(String(second.lock.expiresAt));
    current.clock.advance(500);
    const renewed = renewLock(current.runtime, worker, { lockId: String(second.lock.id) });
    expect(Date.parse(String(renewed.expiresAt))).toBeGreaterThan(before);
  });

  it("reacquisition pelo MESMO dono = renovacao segura (nao cria 2o lock)", () => {
    const first = acquireLock(current.runtime, coordinator, {
      path: "login.html",
      intent: "intencao inicial",
    });
    const again = acquireLock(current.runtime, coordinator, {
      path: "login.html",
      intent: "intencao atualizada",
    });
    expect(again.reacquired).toBe(true);
    expect(String(again.lock.id)).toBe(String(first.lock.id));
    const held = current.db
      .prepare("SELECT COUNT(*) AS total FROM file_locks WHERE status = 'held'")
      .get();
    expect(Number(held?.["total"])).toBe(1);
  });

  it("expiry com clock injetavel: lock abandonado expira e pode ser readquirido", () => {
    const first = acquireLock(current.runtime, coordinator, {
      path: "login.html",
      intent: "vou abandonar",
    });
    current.clock.advance(2000); // > lockTtlMs (1000)

    const second = acquireLock(current.runtime, worker, {
      path: "login.html",
      intent: "assumir arquivo",
    });
    expect(second.reacquired).toBe(false);
    const old = assertUsableLockError(first.lock.id);
    expect(old.code).toBe("LOCK_EXPIRED");
    const expiredRows = current.db
      .prepare("SELECT status FROM file_locks WHERE id = ?")
      .get(String(first.lock.id));
    expect(expiredRows?.["status"]).toBe("expired");
  });

  function assertUsableLockError(lockId: string): DomainError {
    return catchError(() =>
      assertUsableLock(current.runtime, coordinator, {
        lockId,
        workspaceId: coordinator.room.workspaceId,
        key: "login.html",
      }),
    );
  }
});

describe("autorizacao do lock", () => {
  it("somente o dono renova/libera; coordinator NAO rouba lock do worker", () => {
    const lock = acquireLock(current.runtime, worker, {
      path: "login.html",
      intent: "do worker",
    });
    expect(
      catchError(() => releaseLock(current.runtime, coordinator, { lockId: String(lock.lock.id) }))
        .code,
    ).toBe("FORBIDDEN");
    expect(
      catchError(() => renewLock(current.runtime, coordinator, { lockId: String(lock.lock.id) }))
        .code,
    ).toBe("FORBIDDEN");
    expect(releaseLock(current.runtime, worker, { lockId: String(lock.lock.id) }).status).toBe(
      "released",
    );
  });

  it("taskId precisa pertencer a sala autenticada", async () => {
    const task = current.collaboration.proposeTask(coordinator, { title: "Migrar login" });
    const ok = acquireLock(current.runtime, coordinator, {
      path: "login.html",
      intent: "com tarefa",
      taskId: String(task.id),
    });
    expect(String(ok.lock.taskId)).toBe(String(task.id));

    const bad = catchError(() =>
      acquireLock(current.runtime, worker, {
        path: "shared.txt",
        intent: "com tarefa alheia",
        taskId: "task_inexistente",
      }),
    );
    expect(bad.code).toBe("NOT_FOUND");
  });
});

describe("exclusividade GLOBAL no workspace (entre salas diferentes)", () => {
  it("duas salas no MESMO workspace disputam o mesmo arquivo", async () => {
    acquireLock(current.runtime, coordinator, {
      path: "shared.txt",
      intent: "sala 1",
    });
    const second = await setupSecondRoomSameWorkspace(
      current.collaboration,
      current.clock,
      "ws_test",
    );
    const otherCoordinator = current.collaboration.authenticate(second.coordinatorToken);
    const conflict = catchError(() =>
      acquireLock(current.runtime, otherCoordinator, {
        path: "shared.txt",
        intent: "sala 2",
      }),
    );
    expect(conflict.code).toBe("LOCK_ALREADY_HELD");
    expect(conflict.message).toContain("OpenCode");
    // lockList mostra o lock inclusive para a outra sala.
    const list = lockList(current.runtime, otherCoordinator);
    expect(list.locks.some((l) => String(l.path) === "shared.txt")).toBe(true);
  });

  it("lockStatus consulta o conflito e identifica posse", () => {
    const lock = acquireLock(current.runtime, coordinator, {
      path: "login.html",
      intent: "status test",
    });
    const own = lockStatus(current.runtime, coordinator, { path: "login.html" });
    expect(own.held).not.toBeNull();
    expect(own.ownedByCaller).toBe(true);
    const other = lockStatus(current.runtime, worker, { path: "LOGIN.HTML" });
    expect(other.held).not.toBeNull();
    expect(other.ownedByCaller).toBe(false);
    expect(String(other.held?.id)).toBe(String(lock.lock.id));
  });
});
