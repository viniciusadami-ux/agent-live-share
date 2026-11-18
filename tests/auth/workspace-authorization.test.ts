import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { startApplication, type RunningApplication } from "../../src/application.js";
import { ConfigError, loadWorkspaceDefinitions } from "../../src/config/index.js";
import { createSilentLogger } from "../../src/config/logger.js";
import { readMigrationRecords } from "../../src/persistence/index.js";
import { revokePrincipal } from "../../src/server/auth/principals.js";
import type { WorkspaceDefinition } from "../../src/workspace/index.js";
import { connectTestMcpClient, type TestMcpClient } from "../foundation/helpers/mcpClient.js";
import { cleanupTestRoot } from "../foundation/helpers/tmp.js";
import {
  callError,
  callOk,
  createIntegrationFixture,
  credentialOf,
  type ErrorEnvelope,
  type IntegrationFixture,
} from "../integration/helpers/app.js";
import {
  authHeaders,
  createCapturingLogger,
  initializeBody,
  type CapturingLogger,
} from "./helpers.js";

/**
 * Autorizacao de TRANSPORTE POR WORKSPACE (rodada 2, item 11).
 *
 * Fecha a brecha: "qualquer principal ativo pode criar sala em qualquer
 * workspace allowlisted". A lista `allowedPrincipals` e configuracao do
 * SERVIDOR (fail-closed), revalidada em TODA chamada de workspace/locking/
 * checkpoint e tambem em create_room / join_room / create_invite.
 *
 * Todos os testes usam a aplicacao REAL (startApplication + Bearer + 2 ou 3
 * clientes MCP oficiais em conexoes distintas), nunca mocks de transporte.
 */

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

interface Ctx {
  readonly fixture: IntegrationFixture;
  readonly app: RunningApplication;
  readonly a: TestMcpClient;
  readonly b: TestMcpClient;
  readonly c: TestMcpClient;
}

function ids(fixture: IntegrationFixture, ...indices: number[]): string[] {
  return indices.map((index) => String(credentialOf(fixture, index).id));
}

/** Duas arvores de diretorios distintas (o catalogo rejeita roots sobrepostos). */
function definitionsOf(
  fixture: IntegrationFixture,
  allowedA: readonly string[],
  allowedB: readonly string[],
): readonly WorkspaceDefinition[] {
  return [
    {
      id: "ws_a",
      name: "Workspace A",
      rootPath: fixture.root,
      allowedPrincipals: allowedA as WorkspaceDefinition["allowedPrincipals"],
    },
    {
      id: "ws_b",
      name: "Workspace B",
      rootPath: fixture.otherRoot,
      allowedPrincipals: allowedB as WorkspaceDefinition["allowedPrincipals"],
    },
  ];
}

async function startCtx(
  definitionsOfFixture: (fixture: IntegrationFixture) => readonly WorkspaceDefinition[],
  logger = createSilentLogger(),
): Promise<Ctx> {
  const fixture = createIntegrationFixture();
  const definitions = definitionsOfFixture(fixture);
  const app = await startApplication({
    config: fixture.config,
    definitions,
    now: fixture.clock.now,
    logger,
    sessionTtlMs: 3_600_000,
    inviteTtlMs: 3_600_000,
  });
  apps.push(app);
  const a = await connectTestMcpClient(app.mcpUrl, credentialOf(fixture, 0).token);
  const b = await connectTestMcpClient(app.mcpUrl, credentialOf(fixture, 1).token);
  const c = await connectTestMcpClient(app.mcpUrl, credentialOf(fixture, 2).token);
  clients.push(a, b, c);
  return { fixture, app, a, b, c };
}

async function createRoom(
  client: TestMcpClient,
  workspaceId: string,
  displayName = "OpenCode",
): Promise<{ sessionToken: string; room: { workspaceId: string; id: string } }> {
  return callOk(client, "collab_create_room", {
    displayName,
    roomName: "Sala de teste",
    workspaceId,
  });
}

async function raw(client: TestMcpClient, name: string, args: Record<string, unknown>): Promise<unknown> {
  return client.client.callTool({ name, arguments: args });
}

async function expectCode(
  client: TestMcpClient,
  name: string,
  args: Record<string, unknown>,
  code: string,
): Promise<ErrorEnvelope> {
  const error = await callError(client, name, args);
  expect(error.error.code).toBe(code);
  return error;
}

describe("autorizacao por workspace: lista exata e fail-closed", () => {
  it("dois principals autorizados no MESMO workspace colaboram (fluxo e2e completo)", async () => {
    const ctx = await startCtx((f) => definitionsOf(f, ids(f, 0, 1), ids(f, 0, 1)));

    const room = await createRoom(ctx.a, "ws_a");
    expect(room.room.workspaceId).toBe("ws_a");
    const invite = await callOk<{ inviteToken: string }>(ctx.a, "collab_create_invite", {
      token: room.sessionToken,
    });
    const joined = await callOk<{ sessionToken: string }>(ctx.b, "collab_join_room", {
      inviteToken: invite.inviteToken,
      displayName: "Codex",
    });

    const readA = await callOk<{ content: string; hash: string }>(ctx.a, "collab_read_file", {
      token: room.sessionToken,
      path: "login.html",
    });
    expect(readA.content).toBe("<h1>Login</h1>\n");
    const readB = await callOk<{ content: string }>(ctx.b, "collab_read_file", {
      token: joined.sessionToken,
      path: "login.html",
    });
    expect(readB.content).toBe(readA.content);

    const lock = await callOk<{ lock: { id: string } }>(ctx.a, "collab_lock_acquire", {
      token: room.sessionToken,
      path: "login.html",
      intent: "migrar login",
    });
    const patch = await callOk<{ version: number }>(ctx.a, "collab_apply_patch", {
      token: room.sessionToken,
      path: "login.html",
      lockId: lock.lock.id,
      expectedHash: readA.hash,
      replacements: [{ oldText: "<h1>Login</h1>", newText: "<h1>Entrar</h1>" }],
    });
    expect(patch.version).toBe(2);
    const history = await callOk<{ versions: unknown[] }>(ctx.a, "collab_file_history", {
      token: room.sessionToken,
      path: "login.html",
    });
    expect(history.versions).toHaveLength(2);
    await callOk(ctx.a, "collab_lock_release", {
      token: room.sessionToken,
      lockId: lock.lock.id,
    });
  });

  it("descoberta ANTES da primeira sala: list_workspaces sem token usa apenas o Bearer", async () => {
    const ctx = await startCtx((f) => definitionsOf(f, ids(f, 0), ids(f, 1)));

    const listA = await callOk<{ workspaces: Array<{ id: string; name: string }> }>(
      ctx.a,
      "collab_list_workspaces",
      {},
    );
    expect(listA.workspaces.map((workspace) => workspace.id)).toEqual(["ws_a"]);

    const listB = await callOk<{ workspaces: Array<{ id: string }> }>(
      ctx.b,
      "collab_list_workspaces",
      {},
    );
    expect(listB.workspaces.map((workspace) => workspace.id)).toEqual(["ws_b"]);

    const listC = await callOk<{ workspaces: unknown[] }>(
      ctx.c,
      "collab_list_workspaces",
      {},
    );
    expect(listC.workspaces).toEqual([]);

    // Compatibilidade: um token de sessao INVALIDO quando enviado continua
    // sendo rejeitado; o caminho sem token nao ignora credencial ruim.
    await expectCode(
      ctx.a,
      "collab_list_workspaces",
      { token: "collab_s_invalido" },
      "SESSION_INACTIVE",
    );

    const room = await createRoom(ctx.a, "ws_a");
    const listWithSession = await callOk<{ workspaces: Array<{ id: string }> }>(
      ctx.a,
      "collab_list_workspaces",
      { token: room.sessionToken },
    );
    expect(listWithSession.workspaces.map((workspace) => workspace.id)).toEqual(["ws_a"]);
  });

  it("create_room nao e oraculo de existencia: missing e nao autorizado retornam o mesmo FORBIDDEN", async () => {
    const ctx = await startCtx((f) => definitionsOf(f, ids(f, 0), ids(f, 0, 1)));

    // B esta autorizado em ws_b, mas nao em ws_a; ws_missing nao existe.
    const deniedExisting = await expectCode(
      ctx.b,
      "collab_create_room",
      { displayName: "Codex", roomName: "X", workspaceId: "ws_a" },
      "FORBIDDEN",
    );
    const deniedMissing = await expectCode(
      ctx.b,
      "collab_create_room",
      { displayName: "Codex", roomName: "X", workspaceId: "ws_missing" },
      "FORBIDDEN",
    );
    expect(deniedMissing.error.message).toBe(deniedExisting.error.message);
    expect(deniedMissing.error.hint).toBe(deniedExisting.error.hint);
    expect(JSON.stringify(deniedMissing)).not.toContain("ws_missing");
    expect(JSON.stringify(deniedExisting)).not.toContain("ws_a");

    // B continua podendo criar no workspace autorizado.
    const roomB = await createRoom(ctx.b, "ws_b", "Codex");
    expect(roomB.room.workspaceId).toBe("ws_b");
  });

  it("A autorizado, B nao: create negado; convite de A nao amplia; list filtrado", async () => {
    // ws_a: [A, C]; ws_b: [A, B, C]. B tem sessao legitima em ws_b.
    const ctx = await startCtx((f) => definitionsOf(f, ids(f, 0, 2), ids(f, 0, 1, 2)));

    // B NAO pode criar sala em ws_a.
    const denied = await expectCode(ctx.b, "collab_create_room", {
      displayName: "Codex",
      roomName: "Tentativa",
      workspaceId: "ws_a",
    }, "FORBIDDEN");
    expect(denied.error.message).toMatch(/nao autorizado/i);
    // Erro generico: nao vaza principals, lista completa nem ids de workspace.
    expect(JSON.stringify(denied)).not.toContain("prin_");
    expect(JSON.stringify(denied)).not.toContain("ws_a");
    expect(JSON.stringify(denied)).not.toContain("ws_b");

    // B PODE criar sala em ws_b (onde esta listado).
    const roomB = await createRoom(ctx.b, "ws_b", "Codex");
    expect(roomB.room.workspaceId).toBe("ws_b");

    // A cria sala em ws_a e emite convite.
    const roomA = await createRoom(ctx.a, "ws_a");
    const invite = await callOk<{ inviteToken: string }>(ctx.a, "collab_create_invite", {
      token: roomA.sessionToken,
    });

    // Convite valido NAO e bypass para principal nao listado.
    await expectCode(ctx.b, "collab_join_room", {
      inviteToken: invite.inviteToken,
      displayName: "Codex intruso",
    }, "FORBIDDEN");

    // O convite NAO foi consumido: C (autorizado) ainda consegue ingressar.
    const joinedC = await callOk<{ sessionToken: string }>(ctx.c, "collab_join_room", {
      inviteToken: invite.inviteToken,
      displayName: "Claude Code",
    });
    expect(joinedC.sessionToken).toMatch(/^collab_s_/);

    // list_workspaces e FILTRADO e nao vaza principals/root/listas.
    const listB = await callOk<{ workspaces: Array<{ id: string; name: string }> }>(
      ctx.b,
      "collab_list_workspaces",
      { token: roomB.sessionToken },
    );
    expect(listB.workspaces.map((w) => w.id)).toEqual(["ws_b"]);
    for (const w of listB.workspaces) {
      expect(Object.keys(w).sort()).toEqual(["id", "name"]);
    }
    expect(JSON.stringify(listB)).not.toContain("allowedPrincipals");
    expect(JSON.stringify(listB)).not.toContain("prin_");
    expect(JSON.stringify(listB)).not.toContain("ws_a");

    const listA = await callOk<{ workspaces: Array<{ id: string }> }>(
      ctx.a,
      "collab_list_workspaces",
      { token: roomA.sessionToken },
    );
    expect(listA.workspaces.map((w) => w.id).sort()).toEqual(["ws_a", "ws_b"]);
  });

  it("B com sessao em OUTRO workspace nao acessa arquivos/locks/checkpoint do primeiro", async () => {
    const ctx = await startCtx((f) => definitionsOf(f, ids(f, 0, 2), ids(f, 0, 1, 2)));
    const roomA = await createRoom(ctx.a, "ws_a");
    const roomB = await createRoom(ctx.b, "ws_b", "Codex");

    // O workspace vem da SALA do token: B le o arquivo do SEU root, nunca o de A.
    const readB = await callOk<{ content: string }>(ctx.b, "collab_read_file", {
      token: roomB.sessionToken,
      path: "login.html",
    });
    expect(readB.content).toBe("<h1>OUTRO WORKSPACE</h1>\n");
    expect(readB.content).not.toContain("Login");

    // Lock de B fica no workspace ws_b (exclusividade e por workspace).
    const lockB = await callOk<{ lock: { id: string; workspaceId: string } }>(
      ctx.b,
      "collab_lock_acquire",
      { token: roomB.sessionToken, path: "login.html", intent: "trabalho em ws_b" },
    );
    expect(lockB.lock.workspaceId).toBe("ws_b");
    await callOk(ctx.b, "collab_lock_release", {
      token: roomB.sessionToken,
      lockId: lockB.lock.id,
    });

    // Checkpoint aberto por B em ws_b NAO pausa ws_a: A continua podendo gravar.
    await callOk(ctx.b, "collab_checkpoint_begin", { token: roomB.sessionToken });
    const readA = await callOk<{ hash: string }>(ctx.a, "collab_read_file", {
      token: roomA.sessionToken,
      path: "login.html",
    });
    const lockA = await callOk<{ lock: { id: string } }>(ctx.a, "collab_lock_acquire", {
      token: roomA.sessionToken,
      path: "login.html",
      intent: "editar ws_a",
    });
    await callOk(ctx.a, "collab_apply_patch", {
      token: roomA.sessionToken,
      path: "login.html",
      lockId: lockA.lock.id,
      expectedHash: readA.hash,
      replacements: [{ oldText: "<h1>Login</h1>", newText: "<h1>Entrar</h1>" }],
    });
    expect(ctx.fixture).toBeDefined();
    expect(readFileSync(path.join(ctx.fixture.root, "login.html"), "utf8")).toBe(
      "<h1>Entrar</h1>\n",
    );
  });
});

describe("remocao de acesso apos revalidacao (config/catalogo revalidado)", () => {
  it("bloqueia read/patch/lock/checkpoint na PROXIMA chamada e preserva dados", async () => {
    const ctx = await startCtx((f) => definitionsOf(f, ids(f, 0, 1), ids(f, 0, 1)));
    const room = await createRoom(ctx.a, "ws_a");
    const invite = await callOk<{ inviteToken: string }>(ctx.a, "collab_create_invite", {
      token: room.sessionToken,
    });
    const joined = await callOk<{ sessionToken: string }>(ctx.b, "collab_join_room", {
      inviteToken: invite.inviteToken,
      displayName: "Codex",
    });

    // Estado antes da remocao: A ja gravou uma versao.
    const read = await callOk<{ hash: string }>(ctx.a, "collab_read_file", {
      token: room.sessionToken,
      path: "login.html",
    });
    const lock = await callOk<{ lock: { id: string } }>(ctx.a, "collab_lock_acquire", {
      token: room.sessionToken,
      path: "login.html",
      intent: "patch",
    });
    await callOk(ctx.a, "collab_apply_patch", {
      token: room.sessionToken,
      path: "login.html",
      lockId: lock.lock.id,
      expectedHash: read.hash,
      replacements: [{ oldText: "<h1>Login</h1>", newText: "<h1>Entrar</h1>" }],
    });
    await callOk(ctx.a, "collab_lock_release", {
      token: room.sessionToken,
      lockId: lock.lock.id,
    });

    // REVALIDACAO (equivalente a reiniciar com novo workspaces.json): remove B.
    ctx.app.revalidateWorkspaces(definitionsOf(ctx.fixture, ids(ctx.fixture, 0), ids(ctx.fixture, 0, 1)));

    const args = { token: joined.sessionToken, path: "login.html" };
    // Todas as operacoes de workspace/locking/checkpoint de B sao negadas.
    await expectCode(ctx.b, "collab_read_file", args, "FORBIDDEN");
    await expectCode(ctx.b, "collab_list_files", args, "FORBIDDEN");
    await expectCode(ctx.b, "collab_search_files", { ...args, query: "Login" }, "FORBIDDEN");
    await expectCode(ctx.b, "collab_file_history", args, "FORBIDDEN");
    await expectCode(ctx.b, "collab_lock_acquire", { ...args, intent: "x" }, "FORBIDDEN");
    await expectCode(ctx.b, "collab_lock_list", args, "FORBIDDEN");
    await expectCode(ctx.b, "collab_lock_status", args, "FORBIDDEN");
    await expectCode(ctx.b, "collab_checkpoint_status", args, "FORBIDDEN");
    await expectCode(ctx.b, "collab_checkpoint_begin", args, "FORBIDDEN");
    await expectCode(ctx.b, "collab_apply_patch", {
      ...args,
      lockId: "lock_qualquer",
      expectedHash: "0".repeat(64),
      replacements: [{ oldText: "x", newText: "y" }],
    }, "FORBIDDEN");
    await expectCode(ctx.b, "collab_create_file", {
      ...args,
      content: "x",
      lockId: "lock_qualquer",
    }, "FORBIDDEN");
    await expectCode(ctx.b, "collab_restore_version", {
      ...args,
      lockId: "lock_qualquer",
      expectedHash: "0".repeat(64),
      version: 1,
    }, "FORBIDDEN");

    // Dados PRESERVADOS: A continua autorizado e ve conteudo/historico.
    const after = await callOk<{ content: string }>(ctx.a, "collab_read_file", {
      token: room.sessionToken,
      path: "login.html",
    });
    expect(after.content).toBe("<h1>Entrar</h1>\n");
    const history = await callOk<{ versions: unknown[] }>(ctx.a, "collab_file_history", {
      token: room.sessionToken,
      path: "login.html",
    });
    expect(history.versions).toHaveLength(2);
    const listA = await callOk<{ workspaces: Array<{ id: string }> }>(
      ctx.a,
      "collab_list_workspaces",
      { token: room.sessionToken },
    );
    expect(listA.workspaces.map((w) => w.id).sort()).toEqual(["ws_a", "ws_b"]);

    // DECISAO DOCUMENTADA: heartbeat/leave/room_state da PROPRIA sala continuam
    // funcionando (nao leem arquivos); apenas operacoes de workspace sao pausadas.
    await callOk(ctx.b, "collab_heartbeat", { token: joined.sessionToken });
    await callOk(ctx.b, "collab_room_state", { token: joined.sessionToken });
    const left = await callOk<{ status: string }>(ctx.b, "collab_leave", {
      token: joined.sessionToken,
    });
    expect(left.status).toBe("revoked");
  });

  it("coordinator que perde acesso nao emite convites; convites nao ampliam principals", async () => {
    const ctx = await startCtx((f) => definitionsOf(f, ids(f, 0, 1), ids(f, 0, 1)));
    const room = await createRoom(ctx.a, "ws_a");
    // Antes: convite permitido.
    await callOk<{ inviteToken: string }>(ctx.a, "collab_create_invite", {
      token: room.sessionToken,
    });
    // Remove A (o coordinator) da lista de ws_a.
    ctx.app.revalidateWorkspaces(
      definitionsOf(ctx.fixture, ids(ctx.fixture, 1), ids(ctx.fixture, 0, 1)),
    );
    await expectCode(ctx.a, "collab_create_invite", { token: room.sessionToken }, "FORBIDDEN");
    // Sessao da propria sala continua utilizavel para encerrar/heartbeat.
    await callOk(ctx.a, "collab_heartbeat", { token: room.sessionToken });
  });

  it("revogar a CREDENCIAL de transporte continua bloqueando na proxima requisicao", async () => {
    // A autorizacao por workspace NAO substitui a revogacao: principal listado
    // porem revogado e barrado no transporte (401) antes de qualquer tool.
    const ctx = await startCtx((f) => definitionsOf(f, ids(f, 0, 1), ids(f, 0, 1)));
    revokePrincipal(ctx.app.database, String(credentialOf(ctx.fixture, 1).id));
    const response = await fetch(ctx.app.mcpUrl, {
      method: "POST",
      headers: authHeaders(credentialOf(ctx.fixture, 1).token),
      body: initializeBody(),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/Bearer/i);
  });
});

describe("campo ausente/vazio = fail closed; config invalida falha alto", () => {
  it("sem allowedPrincipals: nenhum principal autorizado (create_room FORBIDDEN)", async () => {
    const logger: CapturingLogger = createCapturingLogger();
    const ctx = await startCtx(
      (f) => [
        { id: "ws_a", name: "Workspace A", rootPath: f.root },
        { id: "ws_b", name: "Workspace B", rootPath: f.otherRoot },
      ],
      logger,
    );
    await expectCode(ctx.a, "collab_create_room", {
      displayName: "OpenCode",
      roomName: "Sala",
      workspaceId: "ws_a",
    }, "FORBIDDEN");
    await expectCode(ctx.b, "collab_create_room", {
      displayName: "Codex",
      roomName: "Sala",
      workspaceId: "ws_b",
    }, "FORBIDDEN");
    // Aviso operacional de fail-closed, sem tokens/roots. (Outras linhas do
    // logger local podem citar principalId do proprio portador; isso e um ID,
    // nao um token. Verificamos especificamente as linhas de aviso.)
    const warnLines = logger.lines.filter((line) => line.includes("sem allowedPrincipals"));
    expect(warnLines).toHaveLength(2);
    const warnings = warnLines.join("\n");
    expect(warnings).toMatch(/fail closed/i);
    expect(warnings).not.toContain("prin_");
    expect(warnings).not.toContain(ctx.fixture.root);
  });

  it("allowedPrincipals: [] tambem e fail closed", async () => {
    const ctx = await startCtx((f) => definitionsOf(f, [], []));
    await expectCode(ctx.a, "collab_create_room", {
      displayName: "OpenCode",
      roomName: "Sala",
      workspaceId: "ws_a",
    }, "FORBIDDEN");
  });

  it("config com PrincipalId invalido/duplicado/nao-array derruba o startup", async () => {
    const bad = [
      { allowedPrincipals: "prin_abc" },
      { allowedPrincipals: ["nome-de-pessoa"] },
      { allowedPrincipals: ["collab_p_TOKEN"] },
      { allowedPrincipals: ["*"] },
      { allowedPrincipals: [42] },
      { allowedPrincipals: ["prin_ok", "prin_ok"] },
    ];
    for (const extra of bad) {
      const fixture = createIntegrationFixture();
      const file = path.join(fixture.dir, "workspaces.json");
      writeFileSync(
        file,
        JSON.stringify({
          workspaces: [{ id: "ws_a", name: "A", rootPath: "./root", ...extra }],
        }),
        "utf8",
      );
      expect(() =>
        loadWorkspaceDefinitions({
          env: { COLLAB_WORKSPACES_FILE: "workspaces.json" },
          cwd: fixture.dir,
        }),
      ).toThrow(ConfigError);
    }
  });

  it("startApplication falha alto com definitions invalidas (sem subir meio configurado)", async () => {
    const fixture = createIntegrationFixture();
    await expect(
      startApplication({
        config: fixture.config,
        definitions: [
          {
            id: "ws_a",
            name: "A",
            rootPath: fixture.root,
            allowedPrincipals: ["displayName-invalido" as never],
          },
        ],
        logger: createSilentLogger(),
      }),
    ).rejects.toThrow(/workspaces/i);
  });

  it("config VALIDA preserva allowedPrincipals e resolve rootPath", () => {
    const fixture = createIntegrationFixture();
    writeFileSync(
      path.join(fixture.dir, "workspaces.json"),
      JSON.stringify({
        workspaces: [
          {
            id: "ws_ok",
            name: "OK",
            rootPath: "./root",
            allowedPrincipals: ids(fixture, 0, 1),
          },
        ],
      }),
      "utf8",
    );
    const loaded = loadWorkspaceDefinitions({
      env: { COLLAB_WORKSPACES_FILE: "workspaces.json" },
      cwd: fixture.dir,
    });
    expect(loaded.definitions[0]?.allowedPrincipals).toEqual(ids(fixture, 0, 1));
    expect(loaded.definitions[0]?.rootPath).toBe(path.join(fixture.dir, "root"));
  });
});

describe("sem migration nova: estado v30 preservado e autorizacao aplicada", () => {
  it("restart com o MESMO DB e nova config preserva dados e nega principal removido", async () => {
    const fixture = createIntegrationFixture();
    const initial = definitionsOf(fixture, ids(fixture, 0, 1), ids(fixture, 0, 1));
    const first = await startApplication({
      config: fixture.config,
      definitions: initial,
      now: fixture.clock.now,
      logger: createSilentLogger(),
      sessionTtlMs: 3_600_000,
      inviteTtlMs: 3_600_000,
    });
    apps.push(first);
    const a0 = await connectTestMcpClient(first.mcpUrl, credentialOf(fixture, 0).token);
    const b0 = await connectTestMcpClient(first.mcpUrl, credentialOf(fixture, 1).token);
    clients.push(a0, b0);
    const room = await createRoom(a0, "ws_a");
    const invite = await callOk<{ inviteToken: string }>(a0, "collab_create_invite", {
      token: room.sessionToken,
    });
    const joined = await callOk<{ sessionToken: string }>(b0, "collab_join_room", {
      inviteToken: invite.inviteToken,
      displayName: "Codex",
    });
    const read = await callOk<{ hash: string }>(a0, "collab_read_file", {
      token: room.sessionToken,
      path: "login.html",
    });
    const lock = await callOk<{ lock: { id: string } }>(a0, "collab_lock_acquire", {
      token: room.sessionToken,
      path: "login.html",
      intent: "patch",
    });
    await callOk(a0, "collab_apply_patch", {
      token: room.sessionToken,
      path: "login.html",
      lockId: lock.lock.id,
      expectedHash: read.hash,
      replacements: [{ oldText: "<h1>Login</h1>", newText: "<h1>Entrar</h1>" }],
    });

    // Fecha clientes/servidor e REABRE o mesmo SQLite com config sem B.
    await a0.close();
    await b0.close();
    clients.splice(clients.indexOf(a0), 1);
    clients.splice(clients.indexOf(b0), 1);
    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const second = await startApplication({
      config: fixture.config,
      definitions: definitionsOf(fixture, ids(fixture, 0), ids(fixture, 0, 1)),
      now: fixture.clock.now,
      logger: createSilentLogger(),
      sessionTtlMs: 3_600_000,
      inviteTtlMs: 3_600_000,
    });
    apps.push(second);
    const a1 = await connectTestMcpClient(second.mcpUrl, credentialOf(fixture, 0).token);
    const b1 = await connectTestMcpClient(second.mcpUrl, credentialOf(fixture, 1).token);
    clients.push(a1, b1);

    // Nenhuma migration nova: segue v30 e 5 registros.
    expect(readMigrationRecords(second.database).map((m) => m.version)).toEqual([
      1, 2, 10, 20, 30,
    ]);
    expect(second.migrationResult.currentVersion).toBe(30);

    // Dados preservados (sala, versoes, arquivo).
    const state = await callOk<{ participants: unknown[] }>(a1, "collab_room_state", {
      token: room.sessionToken,
    });
    expect(state.participants).toHaveLength(2);
    const history = await callOk<{ versions: unknown[] }>(a1, "collab_file_history", {
      token: room.sessionToken,
      path: "login.html",
    });
    expect(history.versions).toHaveLength(2);
    expect(readFileSync(path.join(fixture.root, "login.html"), "utf8")).toBe(
      "<h1>Entrar</h1>\n",
    );

    // B ainda autentica (sessao preservada), mas perdeu acesso ao workspace.
    await expectCode(b1, "collab_read_file", { token: joined.sessionToken, path: "login.html" }, "FORBIDDEN");
  });

  it("nenhuma resposta/erro vaza a lista completa de principals ou roots", async () => {
    const ctx = await startCtx((f) => definitionsOf(f, ids(f, 0), ids(f, 0, 1, 2)));
    const roomB = await createRoom(ctx.b, "ws_b", "Codex");

    const results: unknown[] = [];
    results.push(await raw(ctx.b, "collab_list_workspaces", { token: roomB.sessionToken }));
    results.push(
      await raw(ctx.b, "collab_create_room", {
        displayName: "X",
        roomName: "S",
        workspaceId: "ws_a",
      }),
    );
    results.push(await raw(ctx.b, "collab_status", {}));
    const dump = JSON.stringify(results);
    // O NOME do campo pode aparecer no hint acionavel; o que nao pode aparecer
    // e a LISTA serializada, roots do host ou IDs de OUTROS principals.
    expect(dump).not.toContain('"allowedPrincipals":');
    expect(dump).not.toContain("rootPath");
    expect(dump).not.toContain(ctx.fixture.root);
    expect(dump).not.toContain(ctx.fixture.otherRoot);
    // O principal do PROPRIO portador pode aparecer em collab_status; o que
    // nunca pode aparecer e a LISTA completa (IDs de A e C juntos com B).
    expect(dump).not.toContain(String(credentialOf(ctx.fixture, 0).id));
    expect(dump).not.toContain(String(credentialOf(ctx.fixture, 2).id));
  });
});
