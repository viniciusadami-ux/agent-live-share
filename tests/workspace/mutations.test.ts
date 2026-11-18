import { readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { asPrincipalId, DomainError, isDomainError } from "../../src/contracts/index.js";
import type { AuthenticatedActor } from "../../src/collaboration/index.js";
import { acquireLock } from "../../src/locking/index.js";
import {
  applyPatch,
  buildVersionPlan,
  createFile,
  createWorkspaceRuntime,
  encodeUtf8,
  fileHistory,
  insertPendingWrite,
  performMutation,
  readFile,
  realMutationFileSystem,
  recoverPendingWrites,
  restoreVersion,
  sha256Hex,
  type MutationFileSystem,
  type PatchReplacement,
} from "../../src/workspace/index.js";
import {
  createWorkspaceFixture,
  cleanupTestRoot,
  type WorkspaceFixture,
} from "./helpers/fixture.js";
import { setupRoomWithWorker } from "./helpers/rooms.js";

let current: WorkspaceFixture;
let coordinator: AuthenticatedActor;
let worker: AuthenticatedActor;
let coordinatorToken: string;

beforeEach(async () => {
  current = createWorkspaceFixture({ sessionTtlMs: 3_600_000 });
  const room = await setupRoomWithWorker(current.collaboration, current.clock);
  coordinator = current.collaboration.authenticate(room.coordinatorToken);
  worker = current.collaboration.authenticate(room.workerToken);
  coordinatorToken = room.coordinatorToken;
});
afterEach(() => {
  try {
    current.close();
  } catch {
    /* ja fechado por reopen() */
  }
});
afterAll(cleanupTestRoot);

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

function lockAndRead(
  relative: string,
  actor: AuthenticatedActor = coordinator,
): { lockId: string; hash: string; content: string } {
  const lock = acquireLock(current.runtime, actor, { path: relative, intent: "patch de teste" });
  const read = readFile(current.runtime, actor, { path: relative });
  return { lockId: String(lock.lock.id), hash: String(read.hash), content: read.content };
}

function patchArgs(
  base: { lockId: string; hash: string },
  replacements: readonly PatchReplacement[],
) {
  return {
    path: "login.html",
    lockId: base.lockId,
    expectedHash: base.hash,
    replacements,
  };
}

describe("escrita exige lock valido + expectedHash atual", () => {
  it("sem lock (lockId inexistente) => LOCK_NOT_HELD", () => {
    const read = readFile(current.runtime, coordinator, { path: "login.html" });
    expect(
      codeOf(() =>
        applyPatch(current.runtime, coordinator, {
          ...patchArgs({ lockId: "lock_inexistente", hash: String(read.hash) }, [
            { oldText: "Login", newText: "Entrar" },
          ]),
        }),
      ),
    ).toBe("LOCK_NOT_HELD");
  });

  it("com lock ALHEIO (outro agente/sessao) => FORBIDDEN", () => {
    const workerLock = acquireLock(current.runtime, worker, {
      path: "login.html",
      intent: "do worker",
    });
    const read = readFile(current.runtime, coordinator, { path: "login.html" });
    const error = catchError(() =>
      applyPatch(current.runtime, coordinator, {
        ...patchArgs({ lockId: String(workerLock.lock.id), hash: String(read.hash) }, [
          { oldText: "Login", newText: "Entrar" },
        ]),
      }),
    );
    expect(error.code).toBe("FORBIDDEN");
  });

  it("com lock EXPIRADO => LOCK_EXPIRED", () => {
    const base = lockAndRead("login.html");
    current.clock.advance(6 * 60_000 + 1); // > lockTtlMs padrao (5 min)
    expect(
      codeOf(() =>
        applyPatch(current.runtime, coordinator, patchArgs(base, [
          { oldText: "Login", newText: "Entrar" },
        ])),
      ),
    ).toBe("LOCK_EXPIRED");
  });

  it("expectedHash antigo (arquivo mudou fora do MCP) => HASH_MISMATCH", () => {
    const base = lockAndRead("login.html");
    current.writeHostFile("login.html", "<h1>Login</h1>\n<!-- editado fora -->\n");
    expect(
      codeOf(() =>
        applyPatch(current.runtime, coordinator, patchArgs(base, [
          { oldText: "Login", newText: "Entrar" },
        ])),
      ),
    ).toBe("HASH_MISMATCH");
  });

  it("lock para OUTRO arquivo => LOCK_NOT_HELD", () => {
    const otherLock = acquireLock(current.runtime, coordinator, {
      path: "shared.txt",
      intent: "outro arquivo",
    });
    const read = readFile(current.runtime, coordinator, { path: "login.html" });
    expect(
      codeOf(() =>
        applyPatch(current.runtime, coordinator, {
          ...patchArgs({ lockId: String(otherLock.lock.id), hash: String(read.hash) }, [
            { oldText: "Login", newText: "Entrar" },
          ]),
        }),
      ),
    ).toBe("LOCK_NOT_HELD");
  });
});

describe("patch delimitado, backup, historico e restauracao", () => {
  it("patch correto: aplica, persiste backup(pre) + nova versao(post) e recalcula hash", () => {
    const base = lockAndRead("login.html");
    const result = applyPatch(
      current.runtime,
      coordinator,
      patchArgs(base, [{ oldText: "<h1>Login</h1>", newText: "<h1>Entrar</h1>" }]),
    );
    expect(current.readHostFile("login.html")).toBe("<h1>Entrar</h1>\n");
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.version).toBe(2); // pre=1, post=2 (primeira mutacao)
    expect(result.previousHash).toBe(base.hash);

    const rows = current.db
      .prepare("SELECT version, hash, existed, kind, content FROM file_versions ORDER BY version")
      .all();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.["kind"]).toBe("pre_mutation");
    expect(Buffer.from(rows[0]?.["content"] as Uint8Array).toString("utf8")).toBe(
      "<h1>Login</h1>\n",
    );
    expect(rows[1]?.["kind"]).toBe("patch");
    expect(Buffer.from(rows[1]?.["content"] as Uint8Array).toString("utf8")).toBe(
      "<h1>Entrar</h1>\n",
    );

    const after = readFile(current.runtime, coordinator, { path: "login.html" });
    expect(after.tracked).toBe(true);
    expect(after.version).toBe(2);
    expect(String(after.hash)).toBe(result.hash);
  });

  it("zero ocorrencias e multiplas ocorrencias inesperadas => PATCH_NOT_APPLICABLE", () => {
    const base = lockAndRead("login.html");
    expect(
      codeOf(() =>
        applyPatch(current.runtime, coordinator, patchArgs(base, [
          { oldText: "NAO_EXISTE", newText: "X" },
        ])),
      ),
    ).toBe("PATCH_NOT_APPLICABLE");

    current.writeHostFile("dup.txt", "foo foo foo\n");
    const dupBase = lockAndRead("dup.txt");
    expect(
      codeOf(() =>
        performMutation(current.runtime, coordinator, {
          path: "dup.txt",
          lockId: dupBase.lockId,
          mode: "update",
          expectedHash: dupBase.hash,
          replacements: [{ oldText: "foo", newText: "bar" }],
        }),
      ),
    ).toBe("PATCH_NOT_APPLICABLE");
  });

  it("expectedOccurrences explicito substitui todas as ocorrencias; sobreposicao e ambigua", () => {
    current.writeHostFile("dup.txt", "foo foo foo\n");
    const dup = lockAndRead("dup.txt");
    const result = performMutation(current.runtime, coordinator, {
      path: "dup.txt",
      lockId: dup.lockId,
      mode: "update",
      expectedHash: dup.hash,
      replacements: [{ oldText: "foo", newText: "bar", expectedOccurrences: 3 }],
    });
    expect(current.readHostFile("dup.txt")).toBe("bar bar bar\n");
    expect(result.replacementsApplied).toBe(1);

    current.writeHostFile("overlap.txt", "abcd\n");
    const ov = lockAndRead("overlap.txt");
    expect(
      codeOf(() =>
        performMutation(current.runtime, coordinator, {
          path: "overlap.txt",
          lockId: ov.lockId,
          mode: "update",
          expectedHash: ov.hash,
          replacements: [
            { oldText: "abc", newText: "X" },
            { oldText: "bcd", newText: "Y" },
          ],
        }),
      ),
    ).toBe("PATCH_NOT_APPLICABLE");
  });

  it("patch que nao altera o conteudo e rejeitado (nao cria versao falsa)", () => {
    const base = lockAndRead("login.html");
    expect(
      codeOf(() =>
        applyPatch(current.runtime, coordinator, patchArgs(base, [
          { oldText: "Login", newText: "Login" },
        ])),
      ),
    ).toBe("PATCH_NOT_APPLICABLE");
  });

  it("criacao explicita registra AUSENCIA anterior como backup e publica nova versao", () => {
    const lock = acquireLock(current.runtime, coordinator, {
      path: "novo.html",
      intent: "criar pagina",
    });
    const result = createFile(current.runtime, coordinator, {
      path: "novo.html",
      lockId: String(lock.lock.id),
      content: "<p>Novo</p>\n",
    });
    expect(current.readHostFile("novo.html")).toBe("<p>Novo</p>\n");
    expect(result.version).toBe(2);
    const rows = current.db
      .prepare(
        "SELECT version, existed, kind, content FROM file_versions WHERE path_key = 'novo.html' ORDER BY version",
      )
      .all();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.["existed"]).toBe(0); // ausencia anterior
    expect(rows[0]?.["content"]).toBeNull();
    expect(rows[1]?.["existed"]).toBe(1);
  });

  it("restore cria NOVA versao (historico nunca e apagado)", () => {
    const base = lockAndRead("login.html");
    const first = applyPatch(
      current.runtime,
      coordinator,
      patchArgs(base, [{ oldText: "<h1>Login</h1>", newText: "<h1>Entrar</h1>" }]),
    );
    const second = lockAndRead("login.html");
    applyPatch(
      current.runtime,
      coordinator,
      patchArgs(second, [{ oldText: "<h1>Entrar</h1>", newText: "<h1>Acesso</h1>" }]),
    );

    const before = fileHistory(current.runtime, coordinator.room.workspaceId, {
      path: "login.html",
    });
    const countBefore = before.versions.length;

    const restoreBase = lockAndRead("login.html");
    const restored = restoreVersion(current.runtime, coordinator, {
      path: "login.html",
      lockId: restoreBase.lockId,
      expectedHash: restoreBase.hash,
      version: first.version,
    });
    expect(restored.restoredFromVersion).toBe(first.version);
    expect(current.readHostFile("login.html")).toBe("<h1>Entrar</h1>\n");
    const after = fileHistory(current.runtime, coordinator.room.workspaceId, {
      path: "login.html",
    });
    expect(after.versions.length).toBeGreaterThan(countBefore);
    expect(after.versions.some((v) => v.version === first.version)).toBe(true);
  });

  it("historico e isolado por workspace", async () => {
    const base = lockAndRead("login.html");
    applyPatch(current.runtime, coordinator, patchArgs(base, [
      { oldText: "Login", newText: "Entrar" },
    ]));
    const other = await current.collaboration.createRoom({
      displayName: "B",
      roomName: "outra",
      workspaceId: "ws_other",
    });
    const otherActor = current.collaboration.authenticate(other.sessionToken);
    const empty = fileHistory(current.runtime, otherActor.room.workspaceId, { path: "login.html" });
    expect(empty.versions).toHaveLength(0);
  });
});

describe("falha de filesystem e recuperacao conservadora", () => {
  it("falha no rename: original intacto, sem versao falsa, sem temporario, sem journal", async () => {
    const failingFs: MutationFileSystem = {
      writeTemp: (t, n, c) => realMutationFileSystem.writeTemp(t, n, c),
      replace: () => {
        throw new Error("falha de disco simulada");
      },
      cleanup: (p) => realMutationFileSystem.cleanup(p),
    };
    const failing = createWorkspaceFixture({ fs: failingFs, sessionTtlMs: 3_600_000 });
    try {
      const room = await setupRoomWithWorker(failing.collaboration, failing.clock);
      const actor = failing.collaboration.authenticate(room.coordinatorToken);
      const lock = acquireLock(failing.runtime, actor, { path: "login.html", intent: "patch" });
      const read = readFile(failing.runtime, actor, { path: "login.html" });

      const error = catchError(() =>
        applyPatch(failing.runtime, actor, {
          path: "login.html",
          lockId: String(lock.lock.id),
          expectedHash: String(read.hash),
          replacements: [{ oldText: "Login", newText: "Entrar" }],
        }),
      );
      expect(error.code).toBe("INTERNAL");
      expect(failing.readHostFile("login.html")).toBe("<h1>Login</h1>\n");
      expect(
        Number(failing.db.prepare("SELECT COUNT(*) AS c FROM file_versions").get()?.["c"]),
      ).toBe(0);
      expect(
        Number(
          failing.db.prepare("SELECT COUNT(*) AS c FROM file_pending_writes").get()?.["c"],
        ),
      ).toBe(0);
      const leftovers = readdirSync(path.join(failing.root)).filter((n) =>
        n.endsWith(".tmp-collab-write"),
      );
      expect(leftovers).toHaveLength(0);
    } finally {
      failing.close();
    }
  });

  it("principal sem acesso ao workspace NAO dispara recovery de journal alheio", () => {
    const other = createWorkspaceRuntime(current.db, {
      definitions: current.definitions,
      now: current.clock.now,
      principalId: asPrincipalId("prin_outro-sem-acesso"),
    });
    const previousBytes = encodeUtf8("<h1>Login</h1>\n");
    const previousHash = sha256Hex(previousBytes);
    const plan = buildVersionPlan(
      current.db,
      coordinator.room.workspaceId,
      "login.html",
      previousHash,
      true,
    );
    insertPendingWrite(other, {
      id: "mut_recovery_unauthorized",
      workspaceId: coordinator.room.workspaceId,
      path: "login.html",
      key: "login.html",
      expectedHash: previousHash,
      previousExisted: true,
      previousHash,
      previousContent: previousBytes,
      nextExisted: true,
      nextHash: previousHash,
      nextContent: previousBytes,
      baseVersion: plan.baseVersion,
      preNeeded: plan.preNeeded,
      preVersion: plan.preVersion,
      postVersion: plan.postVersion,
      parentVersion: plan.parentVersion,
      kind: "patch",
      createdByAgentId: coordinator.agent.id,
      sessionId: String(coordinator.session.id),
      roomId: String(coordinator.room.id),
      lockId: "lock_recovery_unauthorized",
      createdAt: current.clock.now().toISOString(),
    });

    recoverPendingWrites(other);
    expect(
      Number(
        current.db
          .prepare(
            "SELECT COUNT(*) AS total FROM file_pending_writes WHERE id = ?",
          )
          .get("mut_recovery_unauthorized")?.["total"],
      ),
    ).toBe(1);
  });

  it("journal interrompido e finalizado por recoverPendingWrites", () => {
    // Simula crash DEPOIS do rename e ANTES de T2: disco ja tem o novo conteudo.
    const nextText = "<h1>Recuperado</h1>\n";
    current.writeHostFile("login.html", nextText);
    const nextBytes = encodeUtf8(nextText);
    const nextHash = sha256Hex(nextBytes);
    const previousBytes = encodeUtf8("<h1>Login</h1>\n");
    const previousHash = sha256Hex(previousBytes);
    const plan = buildVersionPlan(
      current.db,
      coordinator.room.workspaceId,
      "login.html",
      previousHash,
      true,
    );
    insertPendingWrite(current.runtime, {
      id: "mut_recover_test",
      workspaceId: coordinator.room.workspaceId,
      path: "login.html",
      key: "login.html",
      expectedHash: previousHash,
      previousExisted: true,
      previousHash,
      previousContent: previousBytes,
      nextExisted: true,
      nextHash,
      nextContent: nextBytes,
      baseVersion: plan.baseVersion,
      preNeeded: plan.preNeeded,
      preVersion: plan.preVersion,
      postVersion: plan.postVersion,
      parentVersion: plan.parentVersion,
      kind: "patch",
      createdByAgentId: coordinator.agent.id,
      sessionId: String(coordinator.session.id),
      roomId: String(coordinator.room.id),
      lockId: "lock_recover",
      createdAt: current.clock.now().toISOString(),
    });

    recoverPendingWrites(current.runtime, {
      workspaceId: coordinator.room.workspaceId,
      key: "login.html",
    });
    expect(
      Number(current.db.prepare("SELECT COUNT(*) AS c FROM file_pending_writes").get()?.["c"]),
    ).toBe(0);
    const versions = fileHistory(current.runtime, coordinator.room.workspaceId, {
      path: "login.html",
    });
    expect(versions.versions.length).toBeGreaterThanOrEqual(2);
  });
});

describe("persistencia apos fechar/reabrir o SQLite", () => {
  it("versoes, conteudo e sessao sobrevivem ao reopen", () => {
    const base = lockAndRead("login.html");
    const result = applyPatch(current.runtime, coordinator, patchArgs(base, [
      { oldText: "Login", newText: "Entrar" },
    ]));
    const reopened = current.reopen();
    current = reopened;
    expect(reopened.readHostFile("login.html")).toBe("<h1>Entrar</h1>\n");
    const history = fileHistory(reopened.runtime, coordinator.room.workspaceId, {
      path: "login.html",
    });
    expect(history.versions.some((v) => v.version === result.version)).toBe(true);
    // A sessao autenticada tambem persiste (a sala/token continuam validos).
    const actor = reopened.collaboration.authenticate(coordinatorToken);
    expect(String(actor.room.workspaceId)).toBe("ws_test");
  });
});
