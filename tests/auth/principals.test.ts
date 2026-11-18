import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  authenticateCollaborationSession,
  collaborationMigrations,
} from "../../src/collaboration/index.js";
import {
  foundationMigrations,
  openDatabase,
  runMigrations,
  transportAuthMigrations,
} from "../../src/persistence/index.js";
import { lockingMigrations } from "../../src/locking/index.js";
import { TEST_PRINCIPAL } from "../../src/server/auth/principalContext.js";
import {
  authenticateTransportToken,
  countActivePrincipals,
  createPrincipal,
  listPrincipals,
  revokePrincipal,
} from "../../src/server/auth/principals.js";
import { workspaceMigrations } from "../../src/workspace/index.js";
import { cleanupTestRoot, createTestDir } from "../foundation/helpers/tmp.js";

afterAll(cleanupTestRoot);

const LEGACY_MIGRATIONS = [
  ...foundationMigrations,
  ...collaborationMigrations,
  ...workspaceMigrations,
  ...lockingMigrations,
] as const;

function runCli(
  args: readonly string[],
  dbPath: string,
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli/auth.ts", ...args],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        COLLAB_DB_PATH: dbPath,
        COLLAB_LOG_LEVEL: "error",
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("store de principals", () => {
  it("cria, autentica, lista sem segredos e revoga com efeito imediato", () => {
    const dir = createTestDir("principals-store");
    const db = openDatabase(path.join(dir, "principals.sqlite"));
    try {
      runMigrations(db, [...foundationMigrations, ...transportAuthMigrations]);

      expect(countActivePrincipals(db)).toBe(0);
      const { principal, token } = createPrincipal(db, "Vinicius / OpenCode");
      expect(token).toMatch(/^collab_p_[A-Za-z0-9_-]+$/);
      expect(principal.id).toMatch(/^prin_/);
      expect(countActivePrincipals(db)).toBe(1);

      const authenticated = authenticateTransportToken(db, token);
      expect(authenticated?.id).toBe(principal.id);
      expect(authenticated?.name).toBe("Vinicius / OpenCode");
      expect(authenticateTransportToken(db, "collab_p_inexistente")).toBeUndefined();

      const views = listPrincipals(db);
      expect(views).toHaveLength(1);
      expect(Object.keys(views[0] ?? {}).sort()).toEqual([
        "createdAt",
        "id",
        "name",
        "status",
      ]);
      const serialized = JSON.stringify(views);
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain("token_hash");

      const raw = JSON.stringify(db.prepare("SELECT * FROM transport_principals").all());
      expect(raw).not.toContain(token);
      expect(raw).toContain(createHash("sha256").update(token, "utf8").digest("hex"));

      const revoked = revokePrincipal(db, String(principal.id));
      expect(revoked.status).toBe("revoked");
      expect(authenticateTransportToken(db, token)).toBeUndefined();
      expect(countActivePrincipals(db)).toBe(0);
      // Idempotente.
      expect(revokePrincipal(db, String(principal.id)).status).toBe("revoked");
    } finally {
      db.close();
    }
  });
});

describe("CLI administrativo (create/list/revoke)", () => {
  it("token aparece SOMENTE no create; list/revoke nunca o exibem", () => {
    const dir = createTestDir("principals-cli");
    const dbPath = path.join(dir, "cli.sqlite");

    const created = runCli(["create", "Vinicius / OpenCode"], dbPath);
    expect(created.status).toBe(0);
    const match = /collab_p_[A-Za-z0-9_-]+/.exec(created.stdout);
    const token = match?.[0] ?? "";
    expect(token.length).toBeGreaterThan(20);
    expect(created.stdout).toContain("UMA vez");

    const idMatch = /prin_[0-9a-f-]+/.exec(created.stdout);
    const principalId = idMatch?.[0] ?? "";
    expect(principalId.length).toBeGreaterThan(5);

    const listed = runCli(["list"], dbPath);
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain(principalId);
    expect(listed.stdout).toContain("token e hash nunca");
    expect(listed.stdout).not.toContain(token);

    const revoked = runCli(["revoke", principalId], dbPath);
    expect(revoked.status).toBe(0);
    expect(revoked.stdout).toContain("revoked");
    expect(revoked.stdout).not.toContain(token);

    const finalList = runCli(["list"], dbPath);
    expect(finalList.stdout).toContain("revoked");
    expect(finalList.stdout).not.toContain(token);
    expect(`${created.stdout}${listed.stdout}${revoked.stdout}${finalList.stdout}`).not.toContain(
      "Authorization",
    );

    const dbBytes = readFileSync(dbPath);
    expect(dbBytes.includes(Buffer.from(token, "utf8"))).toBe(false);
  });

  it("rejeita create sem nome e comando desconhecido sem imprimir segredo", () => {
    const dir = createTestDir("principals-cli-invalid");
    const dbPath = path.join(dir, "cli.sqlite");
    expect(runCli(["create"], dbPath).status).toBe(2);
    expect(runCli(["list"], dbPath).stdout).toContain("Nenhuma credencial");
    expect(runCli(["comando-inexistente"], dbPath).status).toBe(2);
  });
});

describe("migration 030 sobre DB existente v20", () => {
  it("preserva sala/agente/participante/sessao e marca sessao legada sem principal", () => {
    const dir = createTestDir("migration-v30");
    const dbPath = path.join(dir, "legacy.sqlite");
    const legacyToken = "collab_s_sessao_legada";
    const legacyHash = createHash("sha256").update(legacyToken, "utf8").digest("hex");
    const future = "2099-01-01T00:00:00.000Z";

    const db = openDatabase(dbPath);
    runMigrations(db, LEGACY_MIGRATIONS);
    db.transaction(() => {
      db.prepare(
        "INSERT INTO collab_agents (id, display_name, client_kind, created_at) VALUES (?, ?, ?, ?)",
      ).run("ag_legado", "Agente legado", "opencode", "2026-01-01T00:00:00.000Z");
      db.prepare(
        `INSERT INTO collab_rooms
         (id, name, workspace_id, coordinator_agent_id, created_by_agent_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("room_legada", "Sala legada", "ws_legado", "ag_legado", "ag_legado", "2026-01-01T00:00:00.000Z");
      db.prepare(
        `INSERT INTO collab_participants
         (room_id, agent_id, roles, active, coordinator_slot, joined_at, updated_at)
         VALUES (?, ?, ?, 1, 1, ?, ?)`,
      ).run("room_legada", "ag_legado", '["coordinator","worker"]', "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
      db.prepare(
        `INSERT INTO collab_sessions
         (id, room_id, agent_id, token_hash, status, created_at, last_heartbeat_at, expires_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
      ).run("sessao_legada", "room_legada", "ag_legado", legacyHash, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", future);
    });
    db.close();

    const upgraded = openDatabase(dbPath);
    try {
      const result = runMigrations(upgraded, [...LEGACY_MIGRATIONS, ...transportAuthMigrations]);
      expect(result.applied.map((migration) => migration.version)).toEqual([30]);
      expect(result.currentVersion).toBe(30);

      // Dados legados preservados.
      expect(
        Number(upgraded.prepare("SELECT COUNT(*) AS total FROM collab_rooms").get()?.["total"]),
      ).toBe(1);
      expect(
        Number(upgraded.prepare("SELECT COUNT(*) AS total FROM collab_agents").get()?.["total"]),
      ).toBe(1);
      expect(
        Number(upgraded.prepare("SELECT COUNT(*) AS total FROM collab_participants").get()?.["total"]),
      ).toBe(1);
      expect(
        Number(upgraded.prepare("SELECT COUNT(*) AS total FROM collab_sessions").get()?.["total"]),
      ).toBe(1);
      expect(
        upgraded.prepare("SELECT principal_id FROM collab_sessions WHERE id = ?").get("sessao_legada")?.[
          "principal_id"
        ],
      ).toBeNull();

      // Sessao legada nao e reivindicavel por nenhum principal autenticado.
      let code = "";
      try {
        authenticateCollaborationSession(upgraded, legacyToken, {
          principalId: TEST_PRINCIPAL.id,
        });
      } catch (error) {
        code = (error as { code?: string }).code ?? "";
      }
      expect(code).toBe("FORBIDDEN");

      // Idempotente e nao recria tabela/coluna.
      const again = runMigrations(upgraded, [...LEGACY_MIGRATIONS, ...transportAuthMigrations]);
      expect(again.applied).toEqual([]);
      expect(again.totalApplied).toBe(5);
    } finally {
      upgraded.close();
    }
  });
});
