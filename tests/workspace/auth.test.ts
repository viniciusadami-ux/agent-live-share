import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  asPrincipalId,
  asWorkspaceId,
  isDomainError,
} from "../../src/contracts/index.js";
import { TEST_PRINCIPAL } from "../../src/server/auth/principalContext.js";
import type { AuthenticatedActor } from "../../src/collaboration/index.js";
import {
  createWorkspaceRuntime,
  fileHistory,
  listFiles,
  readFile,
  type WorkspaceRuntime,
} from "../../src/workspace/index.js";
import {
  createWorkspaceFixture,
  cleanupTestRoot,
  type WorkspaceFixture,
} from "./helpers/fixture.js";
import { setupRoomWithWorker } from "./helpers/rooms.js";

let current: WorkspaceFixture;

beforeEach(() => {
  current = createWorkspaceFixture();
});
afterEach(() => {
  try {
    current.close();
  } catch {
    /* ja fechado */
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

describe("autenticacao e isolamento de workspace por sala", () => {
  it("cada sala le os arquivos do SEU workspace (rooms apontam para roots distintos)", async () => {
    const roomA = await setupRoomWithWorker(current.collaboration, current.clock, "ws_test");
    const actorA: AuthenticatedActor = current.collaboration.authenticate(roomA.coordinatorToken);

    const roomB = await current.collaboration.createRoom({
      displayName: "Outro coordinator",
      roomName: "Sala ws_other",
      workspaceId: "ws_other",
    });
    const actorB = current.collaboration.authenticate(roomB.sessionToken);

    expect(readFile(current.runtime, actorA, { path: "login.html" }).content).toBe(
      "<h1>Login</h1>\n",
    );
    expect(readFile(current.runtime, actorB, { path: "login.html" }).content).toBe(
      "<h1>OTHER WORKSPACE</h1>\n",
    );
    expect(readFile(current.runtime, actorA, { path: "shared.txt" }).content).toBe("v1\n");
    expect(readFile(current.runtime, actorB, { path: "shared.txt" }).content).toBe("OUTRO\n");
  });

  it("o chamador NAO escolhe workspace: actor.room.workspaceId manda, sem agentId/roomId", async () => {
    const room = await setupRoomWithWorker(current.collaboration, current.clock, "ws_test");
    const actor = current.collaboration.authenticate(room.coordinatorToken);
    // Nao existe parametro workspaceId em readFile/listFiles; a sala do token decide.
    const viaToken = readFile(current.runtime, actor, { path: "login.html" });
    expect(viaToken.content).toBe("<h1>Login</h1>\n");
    expect(String(actor.room.workspaceId)).toBe("ws_test");
  });

  it("toda operacao reconfirma o catalogo: workspace removido da allowlist => NOT_FOUND", async () => {
    const room = await setupRoomWithWorker(current.collaboration, current.clock, "ws_test");
    const actor = current.collaboration.authenticate(room.coordinatorToken);

    // Runtime com catalogo que NAO contem mais ws_test (configuracao do servidor mudou).
    const restrictedDefinitions = current.definitions.filter((d) => d.id === "ws_other");
    const restricted: WorkspaceRuntime = createWorkspaceRuntime(current.db, {
      definitions: restrictedDefinitions,
      now: current.clock.now,
      principalId: TEST_PRINCIPAL.id,
    });

    expect(codeOf(() => readFile(restricted, actor, { path: "login.html" }))).toBe("NOT_FOUND");
    expect(codeOf(() => listFiles(restricted, actor, {}))).toBe("NOT_FOUND");
  });

  it("token invalido e rejeitado pela autenticacao usada em toda tool", () => {
    expect(() => current.collaboration.authenticate("token-invalido")).toThrow();
    try {
      current.collaboration.authenticate("token-invalido");
    } catch (error) {
      expect(isDomainError(error) && error.code).toBe("SESSION_INACTIVE");
    }
  });

  it("fileHistory direto tambem respeita allowedPrincipals (defesa de servico)", () => {
    const other = createWorkspaceRuntime(current.db, {
      definitions: current.definitions,
      now: current.clock.now,
      principalId: asPrincipalId("prin_outro-sem-acesso"),
    });
    expect(
      codeOf(() =>
        fileHistory(other, asWorkspaceId("ws_test"), { path: "login.html" }),
      ),
    ).toBe("FORBIDDEN");
  });
});
