import {
  asAgentId,
  asIsoDateTime,
  asRoomId,
  asWorkspaceId,
  DomainError,
  type AgentId,
  type Role,
  type RoomId,
} from "../contracts/index.js";
import type { DatabaseConnection, SqlRow } from "../persistence/index.js";
import {
  fieldBoolean,
  fieldString,
  parseRolesColumn,
} from "./rows.js";
import type {
  AgentView,
  AuthenticatedActor,
  ParticipantIdentity,
  RoomView,
} from "./types.js";

/**
 * Consultas de identidade e autorizacao compartilhadas pelos servicos.
 * Toda autorizacao deriva de linhas persistidas; nada e aceito do chamador.
 */

function toAgentView(row: SqlRow): AgentView {
  return {
    id: asAgentId(fieldString(row, "id")),
    displayName: fieldString(row, "display_name"),
    clientKind: fieldString(row, "client_kind"),
    createdAt: asIsoDateTime(fieldString(row, "created_at")),
  };
}

function toRoomView(row: SqlRow): RoomView {
  return {
    id: asRoomId(fieldString(row, "id")),
    name: fieldString(row, "name"),
    workspaceId: asWorkspaceId(fieldString(row, "workspace_id")),
    coordinatorAgentId: asAgentId(fieldString(row, "coordinator_agent_id")),
    createdByAgentId: asAgentId(fieldString(row, "created_by_agent_id")),
    createdAt: asIsoDateTime(fieldString(row, "created_at")),
  };
}

function toParticipantIdentity(row: SqlRow): ParticipantIdentity {
  return {
    roomId: asRoomId(fieldString(row, "room_id")),
    agentId: asAgentId(fieldString(row, "agent_id")),
    roles: parseRolesColumn(fieldString(row, "roles")),
    active: fieldBoolean(row, "active"),
    joinedAt: asIsoDateTime(fieldString(row, "joined_at")),
  };
}

export function loadAgent(db: DatabaseConnection, agentId: AgentId): AgentView | undefined {
  const row = db.prepare("SELECT * FROM collab_agents WHERE id = ?").get(agentId);
  return row === undefined ? undefined : toAgentView(row);
}

export function loadRoom(db: DatabaseConnection, roomId: RoomId): RoomView | undefined {
  const row = db.prepare("SELECT * FROM collab_rooms WHERE id = ?").get(roomId);
  return row === undefined ? undefined : toRoomView(row);
}

export function loadParticipant(
  db: DatabaseConnection,
  roomId: RoomId,
  agentId: AgentId,
): ParticipantIdentity | undefined {
  const row = db
    .prepare("SELECT * FROM collab_participants WHERE room_id = ? AND agent_id = ?")
    .get(roomId, agentId);
  return row === undefined ? undefined : toParticipantIdentity(row);
}

export function requireParticipant(
  db: DatabaseConnection,
  roomId: RoomId,
  agentId: AgentId,
): { readonly agent: AgentView; readonly participant: ParticipantIdentity } {
  const agent = loadAgent(db, agentId);
  const participant = loadParticipant(db, roomId, agentId);
  if (agent === undefined || participant === undefined || !participant.active) {
    throw new DomainError("NOT_FOUND", "Participante ativo nao encontrado nesta sala.", {
      hint: "Use um agente que ja tenha ingressado na sala via convite.",
      context: { agentId, roomId },
    });
  }
  return { agent, participant };
}

/**
 * O coordinator e SEMPRE o definido na sala. O papel exibido na sessao nao
 * concede autoridade por si so; a comparacao e feita contra a linha da sala.
 */
export function requireCoordinator(actor: AuthenticatedActor): void {
  if (actor.room.coordinatorAgentId !== actor.agent.id) {
    throw new DomainError("FORBIDDEN", "Somente o coordinator da sala pode executar esta operacao.", {
      hint: "Peca ao coordinator atual ou use collab_room_state para identificar quem coordena a sala.",
      context: { roomId: actor.room.id },
    });
  }
}

export function hasRole(actor: AuthenticatedActor, role: Role): boolean {
  return actor.roles.includes(role);
}

export function uniqueRoles(roles: readonly Role[]): readonly Role[] {
  const result: Role[] = [];
  for (const role of roles) {
    if (!result.includes(role)) result.push(role);
  }
  return result;
}

/** Remove/insere papeis mantendo o coordinator como autoridade separada. */
export function withRole(roles: readonly Role[], role: Role): readonly Role[] {
  return uniqueRoles([...roles, role]);
}

export function withoutRole(roles: readonly Role[], role: Role): readonly Role[] {
  return roles.filter((item) => item !== role);
}

/** Linha da sala precisa existir para operacoes de leitura. */
export function requireRoom(db: DatabaseConnection, roomId: RoomId): RoomView {
  const room = loadRoom(db, roomId);
  if (room === undefined) {
    throw new DomainError("NOT_FOUND", "Sala nao encontrada.", {
      hint: "A sala pode ter sido removida; crie uma nova sala.",
      context: { roomId },
    });
  }
  return room;
}
