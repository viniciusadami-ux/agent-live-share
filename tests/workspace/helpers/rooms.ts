import type { CollaborationService } from "../../../src/collaboration/index.js";
import type { TestClock } from "../../collaboration/helpers/fixture.js";

export interface RoomAgents {
  readonly roomId: string;
  readonly coordinatorToken: string;
  readonly coordinatorAgentId: string;
  readonly workerToken: string;
  readonly workerAgentId: string;
}

/** Cria sala + 1 convite de worker e ingressa o segundo agente. */
export async function setupRoomWithWorker(
  collaboration: CollaborationService,
  clock: TestClock,
  workspaceId = "ws_test",
): Promise<RoomAgents> {
  const room = await collaboration.createRoom({
    displayName: "OpenCode",
    clientKind: "opencode",
    roomName: "Migracao",
    workspaceId,
  });
  const invite = collaboration.createInvite(collaboration.authenticate(room.sessionToken), {});
  const worker = collaboration.joinRoom({
    inviteToken: invite.inviteToken,
    displayName: "Codex",
    clientKind: "codex",
  });
  clock.advance(1000);
  return {
    roomId: String(room.room.id),
    coordinatorToken: room.sessionToken,
    coordinatorAgentId: String(room.agent.id),
    workerToken: worker.sessionToken,
    workerAgentId: String(worker.agent.id),
  };
}

/** Cria uma SEGUNDA sala no MESMO workspace com seu proprio coordinator. */
export async function setupSecondRoomSameWorkspace(
  collaboration: CollaborationService,
  clock: TestClock,
  workspaceId = "ws_test",
): Promise<{ roomId: string; coordinatorToken: string; coordinatorAgentId: string }> {
  const room = await collaboration.createRoom({
    displayName: "Claude Code (outra sala)",
    clientKind: "claude-code",
    roomName: "Outra sala mesmo workspace",
    workspaceId,
  });
  // Avanco minimo so para ordenar eventos; NAO pode expirar locks (lockTtlMs).
  clock.advance(1);
  return {
    roomId: String(room.room.id),
    coordinatorToken: room.sessionToken,
    coordinatorAgentId: String(room.agent.id),
  };
}
