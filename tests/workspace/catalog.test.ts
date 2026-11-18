import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { asWorkspaceId } from "../../src/contracts/index.js";
import {
  createWorkspaceCatalog,
  type WorkspaceCatalog,
} from "../../src/workspace/index.js";
import {
  createWorkspaceFixture,
  cleanupTestRoot,
  type WorkspaceFixture,
} from "./helpers/fixture.js";

let current: WorkspaceFixture;

beforeEach(() => {
  current = createWorkspaceFixture();
});
afterEach(() => {
  try {
    current.close();
  } catch {
    /* ja fechado por reopen() */
  }
});
afterAll(cleanupTestRoot);

describe("catalogo persistente de workspaces", () => {
  it("e idempotente, permite ws_test/ws_other e rejeita ws_missing", () => {
    const db = current.db;
    const first: WorkspaceCatalog = createWorkspaceCatalog(db, current.definitions);
    const second: WorkspaceCatalog = createWorkspaceCatalog(db, current.definitions);
    expect(first.workspaceExists(asWorkspaceId("ws_test"))).toBe(true);
    expect(second.workspaceExists(asWorkspaceId("ws_other"))).toBe(true);
    expect(second.workspaceExists(asWorkspaceId("ws_missing"))).toBe(false);
    expect(second.size).toBe(2);
    const rows = db.prepare("SELECT id, name FROM ws_catalog ORDER BY id").all();
    expect(rows).toHaveLength(2);
  });

  it("collab_create_room valida o workspace contra o catalogo real", async () => {
    // Workspace inexistente e workspace nao autorizado usam o mesmo FORBIDDEN
    // generico para nao servir de oraculo de existencia.
    await expect(
      current.collaboration.createRoom({
        displayName: "X",
        roomName: "Sala",
        workspaceId: "ws_missing",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const ok = await current.collaboration.createRoom({
      displayName: "X",
      roomName: "Sala",
      workspaceId: "ws_test",
    });
    expect(String(ok.room.workspaceId)).toBe("ws_test");
  });

  it("NUNCA expoe rootPath/realRoot nas respostas (listSafe so tras id/name)", () => {
    const safe = current.runtime.catalog.listSafe();
    expect(safe).toHaveLength(2);
    for (const entry of safe) {
      expect(Object.keys(entry).sort()).toEqual(["id", "name"]);
    }
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain(current.root);
    expect(serialized).not.toContain("rootPath");
    expect(serialized).not.toContain("root_realpath");
    expect(serialized).not.toContain("realRoot");
    // rootPath existe APENAS na tabela interna do servidor, nunca na resposta.
    const dbRow = current.db.prepare("SELECT * FROM ws_catalog WHERE id = 'ws_test'").get();
    expect(String(dbRow?.["root_realpath"])).toContain("root");
  });

  it("rejeita definicoes invalidas: id-caminho, root ausente, nao-diretorio e duplicata", () => {
    const db = current.db;
    expect(() =>
      createWorkspaceCatalog(db, [{ id: "C:\\segredo", name: "x", rootPath: current.root }]),
    ).toThrow();
    expect(() =>
      createWorkspaceCatalog(db, [{ id: "ok", name: "x", rootPath: "" }]),
    ).toThrow();
    expect(() =>
      createWorkspaceCatalog(db, [
        { id: "ok", name: "x", rootPath: current.dbPath + ".nope" },
      ]),
    ).toThrow();
    expect(() =>
      createWorkspaceCatalog(db, [
        { id: "dup", name: "x", rootPath: current.root },
        { id: "dup", name: "y", rootPath: current.root },
      ]),
    ).toThrow(/duplicad|unico/i);
  });

  it("rejeita roots iguais ou sobrepostos (locks nao podem ser contornados por alias)", () => {
    expect(() =>
      createWorkspaceCatalog(current.db, [
        { id: "a", name: "A", rootPath: current.root },
        { id: "b", name: "B", rootPath: path.join(current.root, "src") },
      ]),
    ).toThrow(/sobrepostos/i);
    expect(() =>
      createWorkspaceCatalog(current.db, [
        { id: "a", name: "A", rootPath: current.root },
        { id: "b", name: "B", rootPath: current.root },
      ]),
    ).toThrow(/sobrepostos/i);
  });

  it("persiste apos fechar/reabrir o SQLite (catalogo e sala continuam validos)", async () => {
    const room = await current.collaboration.createRoom({
      displayName: "Coord",
      roomName: "Sala",
      workspaceId: "ws_test",
    });
    const token = room.sessionToken;

    const reopened = current.reopen();
    current = reopened;
    expect(reopened.runtime.catalog.workspaceExists(asWorkspaceId("ws_test"))).toBe(true);
    const rows = reopened.db.prepare("SELECT COUNT(*) AS total FROM ws_catalog").get();
    expect(Number(rows?.["total"])).toBe(2);
    // A sala/token sobrevivem e o workspace continua autorizado.
    const actor = reopened.collaboration.authenticate(token);
    expect(String(actor.room.workspaceId)).toBe("ws_test");
    expect(reopened.runtime.catalog.resolve(actor.room.workspaceId)).toBeDefined();
  });
});
