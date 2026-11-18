import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { RunningApplication } from "../../src/application.js";
import { revokePrincipal } from "../../src/server/auth/principals.js";
import { connectTestMcpClient, type TestMcpClient } from "../foundation/helpers/mcpClient.js";
import { callError, callOk } from "../integration/helpers/app.js";
import { cleanupTestRoot, startAuthTestApp } from "./helpers.js";

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

interface RoomData {
  readonly sessionToken: string;
  readonly session: { readonly id: string };
  readonly agent: { readonly id: string };
  readonly room: { readonly id: string };
}

function principalIdOfSession(app: RunningApplication, sessionId: string): string | null {
  const row = app.database
    .prepare("SELECT principal_id FROM collab_sessions WHERE id = ?")
    .get(sessionId);
  const value = row?.["principal_id"];
  return value === null || value === undefined ? null : String(value);
}

describe("vinculo identidade de transporte <-> sessao de sala", () => {
  it("create_room e join gravam o principal_id de QUEM os executou", async () => {
    const { app, credentialA, credentialB } = await startAuthTestApp();
    apps.push(app);

    const a = await connectTestMcpClient(app.mcpUrl, credentialA.token);
    const b = await connectTestMcpClient(app.mcpUrl, credentialB.token);
    clients.push(a, b);

    const room = await callOk<RoomData>(a, "collab_create_room", {
      displayName: "OpenCode",
      roomName: "Sala A",
      workspaceId: "ws_integration",
    });
    expect(principalIdOfSession(app, room.session.id)).toBe(credentialA.id);

    const invite = await callOk<{ inviteToken: string }>(a, "collab_create_invite", {
      token: room.sessionToken,
    });
    const joined = await callOk<RoomData>(b, "collab_join_room", {
      inviteToken: invite.inviteToken,
      displayName: "Codex",
      clientKind: "codex",
    });
    expect(principalIdOfSession(app, joined.session.id)).toBe(credentialB.id);
    expect(joined.session.id).not.toBe(room.session.id);
  });

  it("principal B NAO pode usar o sessionToken vazado de A, mesmo em tools de leitura", async () => {
    const { app, credentialA, credentialB } = await startAuthTestApp();
    apps.push(app);

    const a = await connectTestMcpClient(app.mcpUrl, credentialA.token);
    const b = await connectTestMcpClient(app.mcpUrl, credentialB.token);
    clients.push(a, b);

    const room = await callOk<RoomData>(a, "collab_create_room", {
      displayName: "OpenCode",
      roomName: "Sala A",
      workspaceId: "ws_integration",
    });

    // A usa o proprio token normalmente.
    expect(
      (await callOk<{ self: { agent: { id: string } } }>(a, "collab_room_state", {
        token: room.sessionToken,
      })).self.agent.id,
    ).toBe(room.agent.id);

    // B, com Bearer valido, nao herda a identidade de A dentro da sala.
    for (const [name, args] of [
      ["collab_room_state", { token: room.sessionToken }],
      ["collab_get_updates", { token: room.sessionToken, cursor: "0" }],
      ["collab_list_tasks", { token: room.sessionToken }],
      ["collab_list_workspaces", { token: room.sessionToken }],
      ["collab_read_file", { token: room.sessionToken, path: "login.html" }],
      ["collab_checkpoint_status", { token: room.sessionToken }],
      ["collab_create_invite", { token: room.sessionToken }],
    ] as const) {
      const error = await callError(b, name, args as Record<string, unknown>);
      expect(error.error.code, name).toBe("FORBIDDEN");
      expect(error.error.hint, name).toMatch(/credencial|Bearer/i);
    }
  });

  it("um mesmo principal pode criar e entrar em varias salas (credencial nao e por sala)", async () => {
    const { app, credentialA } = await startAuthTestApp();
    apps.push(app);

    const a = await connectTestMcpClient(app.mcpUrl, credentialA.token);
    clients.push(a);

    const first = await callOk<RoomData>(a, "collab_create_room", {
      displayName: "OpenCode",
      roomName: "Sala 1",
      workspaceId: "ws_integration",
    });
    const second = await callOk<RoomData>(a, "collab_create_room", {
      displayName: "OpenCode",
      roomName: "Sala 2",
      workspaceId: "ws_integration",
    });

    expect(first.room.id).not.toBe(second.room.id);
    expect(principalIdOfSession(app, first.session.id)).toBe(credentialA.id);
    expect(principalIdOfSession(app, second.session.id)).toBe(credentialA.id);

    // Ambas as sessoes de sala funcionam com a MESMA credencial de transporte.
    expect(
      (await callOk<{ room: { id: string } }>(a, "collab_room_state", {
        token: first.sessionToken,
      })).room.id,
    ).toBe(first.room.id);
    expect(
      (await callOk<{ room: { id: string } }>(a, "collab_room_state", {
        token: second.sessionToken,
      })).room.id,
    ).toBe(second.room.id);
  });

  it("revogar o principal bloqueia o transporte SEM apagar sala/sessao; collab_leave e da sala", async () => {
    const { app, credentialA, credentialB } = await startAuthTestApp();
    apps.push(app);

    const a = await connectTestMcpClient(app.mcpUrl, credentialA.token);
    const b = await connectTestMcpClient(app.mcpUrl, credentialB.token);
    clients.push(a, b);

    const room = await callOk<RoomData>(a, "collab_create_room", {
      displayName: "OpenCode",
      roomName: "Sala persistente",
      workspaceId: "ws_integration",
    });
    const invite = await callOk<{ inviteToken: string }>(a, "collab_create_invite", {
      token: room.sessionToken,
    });
    const joined = await callOk<RoomData>(b, "collab_join_room", {
      inviteToken: invite.inviteToken,
      displayName: "Codex",
    });

    revokePrincipal(app.database, String(credentialA.id));

    // Dados preservados.
    const rooms = app.database.prepare("SELECT COUNT(*) AS total FROM collab_rooms").get();
    expect(Number(rooms?.["total"])).toBe(1);
    expect(principalIdOfSession(app, room.session.id)).toBe(credentialA.id);

    // B continua ativo e NAO herda o sessionToken de A.
    expect(
      (await callError(b, "collab_room_state", { token: room.sessionToken })).error.code,
    ).toBe("FORBIDDEN");
    // A sessao de sala de B continua valida e pode ser encerrada por collab_leave.
    const leave = await callOk<{ status: string }>(b, "collab_leave", {
      token: joined.sessionToken,
    });
    expect(leave.status).toBe("revoked");
  });
});
