import {
  asAgentId,
  asIsoDateTime,
  asRoomId,
  asSessionId,
  asWorkspaceId,
  DomainError,
  type AgentId,
  type PrincipalId,
  type Role,
  type RoomId,
  type SessionId,
  type TaskStatus,
  type WorkspaceId,
} from "../contracts/index.js";
import type { SqlRow } from "../persistence/index.js";
import type { CollaborationRuntime } from "./context.js";
import { appendEvent } from "./events.js";
import { newCollaborationId } from "./ids.js";
import {
  fieldBoolean,
  fieldNumber,
  fieldOptionalNumber,
  fieldOptionalString,
  fieldString,
  parseRolesColumn,
  rolesToJson,
} from "./rows.js";
import {
  loadAgent,
  loadParticipant,
  requireCoordinator,
  requireParticipant,
  requireRoom,
  uniqueRoles,
  withRole,
  withoutRole,
} from "./membership.js";
import { workspaceDirectoryDenied } from "./workspace.js";
import { expireStaleSessions } from "./sessions.js";
import {
  generateInviteToken,
  generateSessionToken,
  hashCollaborationSecret,
  isPlausibleSecret,
} from "./tokens.js";
import type {
  AgentView,
  AuthenticatedActor,
  CreateInviteInput,
  CreateInviteResult,
  CreateRoomCommand,
  CreateRoomResult,
  InviteStatus,
  InviteView,
  JoinRoomCommand,
  JoinRoomResult,
  ParticipantView,
  RoomStateView,
  RoomView,
  SessionView,
  TransferCoordinatorResult,
} from "./types.js";
import {
  normalizeClientKind,
  normalizeText,
  normalizeWorkspaceId,
  validationError,
} from "./validation.js";

const TASK_STATUSES: readonly TaskStatus[] = [
  "proposed",
  "accepted",
  "in_progress",
  "blocked",
  "completed",
  "cancelled",
];

function emptyTaskSummary(): Record<TaskStatus, number> {
  return {
    proposed: 0,
    accepted: 0,
    in_progress: 0,
    blocked: 0,
    completed: 0,
    cancelled: 0,
  };
}

function participantViewFromRow(row: SqlRow): ParticipantView {
  const lastSeen = fieldOptionalString(row, "last_seen");
  return {
    roomId: asRoomId(fieldString(row, "room_id")),
    agentId: asAgentId(fieldString(row, "agent_id")),
    roles: parseRolesColumn(fieldString(row, "roles")),
    active: fieldBoolean(row, "active"),
    joinedAt: asIsoDateTime(fieldString(row, "joined_at")),
    displayName: fieldString(row, "display_name"),
    clientKind: fieldString(row, "client_kind"),
    coordinator: fieldOptionalNumber(row, "coordinator_slot") === 1,
    activeSessionCount: fieldNumber(row, "active_sessions"),
    lastSeenAt: lastSeen === undefined ? undefined : asIsoDateTime(lastSeen),
  };
}

function loadParticipantView(
  db: CollaborationRuntime["db"],
  roomId: RoomId,
  agentId: AgentId,
  nowIso: string,
): ParticipantView {
  const row = db
    .prepare(
      `SELECT p.room_id, p.agent_id, p.roles, p.active, p.joined_at, p.coordinator_slot,
              a.display_name, a.client_kind,
              (SELECT COUNT(*) FROM collab_sessions s
                 WHERE s.room_id = p.room_id AND s.agent_id = p.agent_id
                   AND s.status = 'active' AND s.expires_at > ?) AS active_sessions,
              (SELECT MAX(s.last_heartbeat_at) FROM collab_sessions s
                 WHERE s.room_id = p.room_id AND s.agent_id = p.agent_id
                   AND s.status = 'active' AND s.expires_at > ?) AS last_seen
       FROM collab_participants p
       JOIN collab_agents a ON a.id = p.agent_id
       WHERE p.room_id = ? AND p.agent_id = ?`,
    )
    .get(nowIso, nowIso, roomId, agentId);
  if (row === undefined) {
    throw new DomainError("NOT_FOUND", "Participante nao encontrado nesta sala.", {
      hint: "Use um agente que ja tenha ingressado na sala via convite.",
      context: { roomId, agentId },
    });
  }
  return participantViewFromRow(row);
}

function toInviteView(row: SqlRow, nowMs: number): InviteView {
  const expiresAt = fieldString(row, "expires_at");
  const revokedAt = fieldOptionalString(row, "revoked_at");
  const uses = fieldNumber(row, "uses");
  const maxUses = fieldNumber(row, "max_uses");
  let status: InviteStatus = "active";
  if (revokedAt !== undefined) status = "revoked";
  else if (Date.parse(expiresAt) <= nowMs) status = "expired";
  else if (uses >= maxUses) status = "exhausted";

  return {
    id: fieldString(row, "id"),
    roomId: asRoomId(fieldString(row, "room_id")),
    roles: parseRolesColumn(fieldString(row, "roles")),
    createdByAgentId: asAgentId(fieldString(row, "created_by_agent_id")),
    createdAt: asIsoDateTime(fieldString(row, "created_at")),
    expiresAt: asIsoDateTime(expiresAt),
    maxUses,
    uses,
    revokedAt: revokedAt === undefined ? undefined : asIsoDateTime(revokedAt),
    status,
  };
}

function sessionView(
  id: SessionId,
  roomId: RoomId,
  agentId: AgentId,
  nowIso: string,
  expiresAt: string,
): SessionView {
  return {
    id,
    roomId,
    agentId,
    status: "active",
    createdAt: asIsoDateTime(nowIso),
    lastHeartbeatAt: asIsoDateTime(nowIso),
    expiresAt: asIsoDateTime(expiresAt),
  };
}

/**
 * AUTORIZACAO POR WORKSPACE em create/join/create_invite.
 *
 * A decisao vem SEMPRE do catalogo/config do servidor (`WorkspaceDirectory`),
 * nunca de argumentos da tool. FAIL-CLOSED: se o diretorio nao implementar
 * `principalCanAccess` (composicao manual incompleta) ou retornar false,
 * negamos com erro generico que nao enumera principals/workspaces.
 * Um convite valido NAO amplia essa autorizacao.
 */
function assertWorkspaceAuthorization(
  runtime: CollaborationRuntime,
  workspaceId: WorkspaceId,
  principalId: PrincipalId,
): void {
  const directory = runtime.workspaceDirectory;
  if (
    typeof directory.principalCanAccess !== "function" ||
    !directory.principalCanAccess(workspaceId, principalId)
  ) {
    throw workspaceDirectoryDenied();
  }
}

export async function createRoom(
  runtime: CollaborationRuntime,
  input: CreateRoomCommand,
): Promise<CreateRoomResult> {
  const displayName = normalizeText(input.displayName, "displayName", 1, 80);
  const roomName = normalizeText(input.roomName, "roomName", 1, 120);
  const workspaceIdText = normalizeWorkspaceId(input.workspaceId);
  const clientKind = normalizeClientKind(input.clientKind);
  const workspaceId = asWorkspaceId(workspaceIdText);

  // AUTORIZACAO ANTES DE EXISTENCIA: um principal sem acesso nao pode usar
  // create_room como oraculo para descobrir quais workspaceIds existem no
  // servidor. Workspace inexistente e workspace existente nao autorizado
  // retornam o MESMO FORBIDDEN generico (fail-closed).
  assertWorkspaceAuthorization(runtime, workspaceId, input.principalId);

  let exists: boolean;
  try {
    exists = await runtime.workspaceDirectory.workspaceExists(workspaceId);
  } catch (error) {
    throw new DomainError("INTERNAL", "Falha ao validar o workspace no catalogo do servidor.", {
      hint: "Verifique o catalogo de workspaces da composicao e tente novamente.",
      cause: error,
    });
  }
  if (!exists) {
    throw new DomainError("NOT_FOUND", "Workspace nao encontrado no catalogo do servidor.", {
      hint: "Use o id de um workspace ja registrado no servidor; caminhos do host nao sao aceitos.",
      context: { workspaceId: workspaceIdText },
    });
  }

  const now = runtime.now();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + runtime.sessionTtlMs).toISOString();
  const agentId = asAgentId(newCollaborationId("agent"));
  const roomId = asRoomId(newCollaborationId("room"));
  const sessionId = asSessionId(newCollaborationId("session"));
  const sessionToken = generateSessionToken();
  const tokenHash = hashCollaborationSecret(sessionToken);
  const roles: readonly Role[] = ["coordinator", "worker"];

  runtime.db.transaction(() => {
    runtime.db
      .prepare(
        `INSERT INTO collab_agents (id, display_name, client_kind, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(agentId, displayName, clientKind, nowIso);

    runtime.db
      .prepare(
        `INSERT INTO collab_rooms (
           id, name, workspace_id, coordinator_agent_id, created_by_agent_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(roomId, roomName, workspaceId, agentId, agentId, nowIso);

    runtime.db
      .prepare(
        `INSERT INTO collab_participants (
           room_id, agent_id, roles, active, coordinator_slot, joined_at, updated_at
         ) VALUES (?, ?, ?, 1, 1, ?, ?)`,
      )
      .run(roomId, agentId, rolesToJson(roles), nowIso, nowIso);

    runtime.db
      .prepare(
        `INSERT INTO collab_sessions (
           id, room_id, agent_id, token_hash, principal_id, status,
           created_at, last_heartbeat_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        sessionId,
        roomId,
        agentId,
        tokenHash,
        input.principalId,
        nowIso,
        nowIso,
        expiresAt,
      );

    appendEvent(runtime.db, {
      roomId,
      type: "room.created",
      actorAgentId: agentId,
      visibility: "room",
      payload: {
        roomId: String(roomId),
        name: roomName,
        workspaceId: workspaceIdText,
        coordinatorAgentId: String(agentId),
        createdByAgentId: String(agentId),
      },
      createdAt: nowIso,
    });
  });

  const agent: AgentView = {
    id: agentId,
    displayName,
    clientKind,
    createdAt: asIsoDateTime(nowIso),
  };
  const room: RoomView = {
    id: roomId,
    name: roomName,
    workspaceId,
    coordinatorAgentId: agentId,
    createdByAgentId: agentId,
    createdAt: asIsoDateTime(nowIso),
  };
  const participant: ParticipantView = {
    roomId,
    agentId,
    roles,
    active: true,
    joinedAt: asIsoDateTime(nowIso),
    displayName,
    clientKind,
    coordinator: true,
    activeSessionCount: 1,
    lastSeenAt: asIsoDateTime(nowIso),
  };

  return {
    agent,
    room,
    participant,
    session: sessionView(sessionId, roomId, agentId, nowIso, expiresAt),
    sessionToken,
  };
}

export function createInvite(
  runtime: CollaborationRuntime,
  actor: AuthenticatedActor,
  input: CreateInviteInput,
): CreateInviteResult {
  requireCoordinator(actor);
  // Convites so podem ser emitidos por um coordinator cujo principal AINDA
  // esteja autorizado para o workspace da sala. Convite nunca amplia principals
  // nem workspaces: o ingresso (joinRoom) revalida a mesma autorizacao.
  assertWorkspaceAuthorization(runtime, actor.room.workspaceId, runtime.principalId);
  const reviewer = input.reviewer === true;
  const maxUses = input.maxUses ?? 1;
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100) {
    throw validationError(
      "maxUses precisa ser um inteiro entre 1 e 100.",
      "Use 1 para convite de uso unico ou ate 100 para um grupo pequeno.",
      "maxUses",
    );
  }
  const expiresInMinutes = input.expiresInMinutes;
  if (
    expiresInMinutes !== undefined &&
    (!Number.isInteger(expiresInMinutes) ||
      expiresInMinutes < 1 ||
      expiresInMinutes > 43_200)
  ) {
    throw validationError(
      "expiresInMinutes precisa ser um inteiro entre 1 e 43200.",
      "Use 1 minuto ate 30 dias (43200 minutos).",
      "expiresInMinutes",
    );
  }
  const ttlMs =
    expiresInMinutes === undefined
      ? runtime.inviteTtlMs
      : expiresInMinutes * 60_000;
  if (
    !Number.isFinite(ttlMs) ||
    !Number.isInteger(ttlMs) ||
    ttlMs <= 0 ||
    ttlMs > 30 * 24 * 60 * 60_000
  ) {
    throw validationError(
      "Validade do convite fora do intervalo permitido.",
      "Use expiresInMinutes entre 1 e 43200 (30 dias).",
      "expiresInMinutes",
    );
  }

  const now = runtime.now();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const inviteId = newCollaborationId("invite");
  const inviteToken = generateInviteToken();
  const tokenHash = hashCollaborationSecret(inviteToken);
  const roles: readonly Role[] = reviewer ? ["worker", "reviewer"] : ["worker"];

  runtime.db.transaction(() => {
    runtime.db
      .prepare(
        `INSERT INTO collab_invites (
           id, room_id, token_hash, roles, created_by_agent_id,
           created_at, expires_at, max_uses, uses
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        inviteId,
        actor.room.id,
        tokenHash,
        rolesToJson(roles),
        actor.agent.id,
        nowIso,
        expiresAt,
        maxUses,
      );

    appendEvent(runtime.db, {
      roomId: actor.room.id,
      type: "invite.created",
      actorAgentId: actor.agent.id,
      visibility: "room",
      payload: {
        inviteId,
        roles: [...roles],
        expiresAt,
        maxUses,
      },
      createdAt: nowIso,
    });
  });

  const row = runtime.db
    .prepare("SELECT * FROM collab_invites WHERE id = ?")
    .get(inviteId);
  if (row === undefined) {
    throw new DomainError("INTERNAL", "Convite nao foi persistido.", {
      hint: "Verifique a integridade do SQLite e tente novamente.",
    });
  }

  return {
    invite: toInviteView(row, now.getTime()),
    inviteToken,
  };
}

function inviteRejected(): DomainError {
  return new DomainError(
    "FORBIDDEN",
    "Convite invalido, expirado, esgotado ou revogado.",
    {
      hint: "Solicite um novo convite ao coordinator da sala.",
    },
  );
}

export function joinRoom(
  runtime: CollaborationRuntime,
  input: JoinRoomCommand,
): JoinRoomResult {
  if (!isPlausibleSecret(input.inviteToken)) {
    throw inviteRejected();
  }
  const displayName = normalizeText(input.displayName, "displayName", 1, 80);
  const clientKind = normalizeClientKind(input.clientKind);
  const tokenHash = hashCollaborationSecret(input.inviteToken);
  const now = runtime.now();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const expiresAt = new Date(nowMs + runtime.sessionTtlMs).toISOString();
  const agentId = asAgentId(newCollaborationId("agent"));
  const sessionId = asSessionId(newCollaborationId("session"));
  const sessionToken = generateSessionToken();
  const sessionTokenHash = hashCollaborationSecret(sessionToken);

  let roomId: RoomId | undefined;
  let inviteId: string | undefined;
  let roles: readonly Role[] = ["worker"];

  runtime.db.transaction(() => {
    const invite = runtime.db
      .prepare("SELECT * FROM collab_invites WHERE token_hash = ?")
      .get(tokenHash);
    if (invite === undefined) throw inviteRejected();

    const inviteRoomId = asRoomId(fieldString(invite, "room_id"));
    const inviteExpiresAt = fieldString(invite, "expires_at");
    const revokedAt = fieldOptionalString(invite, "revoked_at");
    const uses = fieldNumber(invite, "uses");
    const maxUses = fieldNumber(invite, "max_uses");
    if (
      revokedAt !== undefined ||
      Date.parse(inviteExpiresAt) <= nowMs ||
      uses >= maxUses
    ) {
      throw inviteRejected();
    }

    const roomRow = runtime.db
      .prepare("SELECT * FROM collab_rooms WHERE id = ?")
      .get(inviteRoomId);
    if (roomRow === undefined) throw inviteRejected();

    // Um convite valido NAO e bypass: o principal que ingressa precisa estar
    // autorizado para o workspace da sala. A checagem ocorre ANTES de criar
    // agente/sessao e ANTES de consumir o convite (a transacao faz rollback).
    assertWorkspaceAuthorization(
      runtime,
      asWorkspaceId(fieldString(roomRow, "workspace_id")),
      input.principalId,
    );

    const invitedRoles = parseRolesColumn(fieldString(invite, "roles")).filter(
      (role) => role !== "coordinator",
    );
    roles = uniqueRoles(
      invitedRoles.includes("worker") ? invitedRoles : [...invitedRoles, "worker"],
    );

    runtime.db
      .prepare(
        `INSERT INTO collab_agents (id, display_name, client_kind, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(agentId, displayName, clientKind, nowIso);

    runtime.db
      .prepare(
        `INSERT INTO collab_participants (
           room_id, agent_id, roles, active, coordinator_slot, joined_at, updated_at
         ) VALUES (?, ?, ?, 1, NULL, ?, ?)`,
      )
      .run(inviteRoomId, agentId, rolesToJson(roles), nowIso, nowIso);

    runtime.db
      .prepare(
        `INSERT INTO collab_sessions (
           id, room_id, agent_id, token_hash, principal_id, status,
           created_at, last_heartbeat_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        sessionId,
        inviteRoomId,
        agentId,
        sessionTokenHash,
        input.principalId,
        nowIso,
        nowIso,
        expiresAt,
      );

    const consumed = runtime.db
      .prepare(
        `UPDATE collab_invites SET uses = uses + 1
         WHERE id = ? AND revoked_at IS NULL AND uses < max_uses AND expires_at > ?`,
      )
      .run(fieldString(invite, "id"), nowIso);
    if (consumed.changes !== 1) {
      throw new DomainError("CONFLICT", "Convite esgotado ou revogado durante o ingresso.", {
        hint: "Solicite um novo convite ao coordinator e tente novamente.",
      });
    }

    roomId = inviteRoomId;
    inviteId = fieldString(invite, "id");

    appendEvent(runtime.db, {
      roomId: inviteRoomId,
      type: "participant.joined",
      actorAgentId: agentId,
      visibility: "room",
      payload: {
        agentId: String(agentId),
        displayName,
        clientKind,
        roles: [...roles],
        inviteId,
      },
      createdAt: nowIso,
    });
  });

  if (roomId === undefined || inviteId === undefined) {
    throw new DomainError("INTERNAL", "Ingresso nao concluido.", {
      hint: "Verifique a integridade do SQLite e tente novamente.",
    });
  }

  const room = requireRoom(runtime.db, roomId);
  const agent: AgentView = {
    id: agentId,
    displayName,
    clientKind,
    createdAt: asIsoDateTime(nowIso),
  };
  const participant: ParticipantView = {
    roomId,
    agentId,
    roles,
    active: true,
    joinedAt: asIsoDateTime(nowIso),
    displayName,
    clientKind,
    coordinator: false,
    activeSessionCount: 1,
    lastSeenAt: asIsoDateTime(nowIso),
  };

  return {
    agent,
    room,
    participant,
    session: sessionView(sessionId, roomId, agentId, nowIso, expiresAt),
    inviteId,
    sessionToken,
  };
}

export function revokeInvite(
  runtime: CollaborationRuntime,
  actor: AuthenticatedActor,
  inviteId: string,
): InviteView {
  requireCoordinator(actor);
  const id = normalizeText(inviteId, "inviteId", 1, 100);
  const now = runtime.now();
  const nowIso = now.toISOString();

  const row = runtime.db
    .prepare("SELECT * FROM collab_invites WHERE id = ? AND room_id = ?")
    .get(id, actor.room.id);
  if (row === undefined) {
    throw new DomainError("NOT_FOUND", "Convite nao encontrado nesta sala.", {
      hint: "Use um inviteId retornado por collab_create_invite.",
      context: { inviteId: id },
    });
  }

  if (fieldOptionalString(row, "revoked_at") === undefined) {
    runtime.db.transaction(() => {
      const updated = runtime.db
        .prepare(
          "UPDATE collab_invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
        )
        .run(nowIso, id);
      if (updated.changes === 1) {
        appendEvent(runtime.db, {
          roomId: actor.room.id,
          type: "invite.revoked",
          actorAgentId: actor.agent.id,
          visibility: "room",
          payload: { inviteId: id },
          createdAt: nowIso,
        });
      }
    });
  }

  const updated = runtime.db
    .prepare("SELECT * FROM collab_invites WHERE id = ?")
    .get(id);
  if (updated === undefined) {
    throw new DomainError("INTERNAL", "Convite nao encontrado apos atualizacao.", {
      hint: "Verifique a integridade do SQLite e tente novamente.",
    });
  }
  return toInviteView(updated, now.getTime());
}

export function transferCoordinator(
  runtime: CollaborationRuntime,
  actor: AuthenticatedActor,
  targetAgentIdValue: string,
): TransferCoordinatorResult {
  requireCoordinator(actor);
  const targetAgentId = asAgentId(normalizeText(targetAgentIdValue, "targetAgentId", 1, 100));
  if (targetAgentId === actor.agent.id) {
    throw validationError(
      "O coordinator atual nao pode transferir o papel para si mesmo.",
      "Informe outro participante ativo da sala.",
      "targetAgentId",
    );
  }

  const target = requireParticipant(runtime.db, actor.room.id, targetAgentId);
  if (!target.participant.active) {
    throw new DomainError("NOT_FOUND", "Participante ativo nao encontrado nesta sala.", {
      hint: "Use um agente que ja tenha ingressado na sala via convite.",
      context: { agentId: targetAgentId },
    });
  }

  const now = runtime.now();
  const nowIso = now.toISOString();
  const previousCoordinatorAgentId = actor.agent.id;

  runtime.db.transaction(() => {
    const oldParticipant = loadParticipant(runtime.db, actor.room.id, actor.agent.id);
    if (oldParticipant === undefined) {
      throw new DomainError("INTERNAL", "Coordinator atual sem participante.", {
        hint: "Verifique a integridade da sala.",
      });
    }
    const oldRoles = withoutRole(oldParticipant.roles, "coordinator");
    runtime.db
      .prepare(
        `UPDATE collab_participants
         SET roles = ?, coordinator_slot = NULL, updated_at = ?
         WHERE room_id = ? AND agent_id = ?`,
      )
      .run(rolesToJson(oldRoles), nowIso, actor.room.id, actor.agent.id);

    const targetRoles = withRole(target.participant.roles, "coordinator");
    runtime.db
      .prepare(
        `UPDATE collab_participants
         SET roles = ?, coordinator_slot = 1, updated_at = ?
         WHERE room_id = ? AND agent_id = ?`,
      )
      .run(rolesToJson(targetRoles), nowIso, actor.room.id, targetAgentId);

    runtime.db
      .prepare("UPDATE collab_rooms SET coordinator_agent_id = ? WHERE id = ?")
      .run(targetAgentId, actor.room.id);

    appendEvent(runtime.db, {
      roomId: actor.room.id,
      type: "coordinator.transferred",
      actorAgentId: actor.agent.id,
      visibility: "room",
      payload: {
        previousCoordinatorAgentId: String(previousCoordinatorAgentId),
        coordinatorAgentId: String(targetAgentId),
      },
      createdAt: nowIso,
    });
  });

  const room = requireRoom(runtime.db, actor.room.id);
  return {
    room,
    previousCoordinatorAgentId,
    newCoordinator: loadParticipantView(
      runtime.db,
      actor.room.id,
      targetAgentId,
      nowIso,
    ),
  };
}

export function getRoomState(
  runtime: CollaborationRuntime,
  actor: AuthenticatedActor,
): RoomStateView {
  const now = runtime.now();
  const nowIso = now.toISOString();
  expireStaleSessions(runtime.db, now, actor.room.id);
  const room = requireRoom(runtime.db, actor.room.id);
  const coordinator = loadAgent(runtime.db, room.coordinatorAgentId);
  if (coordinator === undefined) {
    throw new DomainError("INTERNAL", "Coordinator da sala nao encontrado.", {
      hint: "Verifique a integridade da sala e dos agentes.",
    });
  }

  const participantRows = runtime.db
    .prepare(
      `SELECT p.room_id, p.agent_id, p.roles, p.active, p.joined_at, p.coordinator_slot,
              a.display_name, a.client_kind,
              (SELECT COUNT(*) FROM collab_sessions s
                 WHERE s.room_id = p.room_id AND s.agent_id = p.agent_id
                   AND s.status = 'active' AND s.expires_at > ?) AS active_sessions,
              (SELECT MAX(s.last_heartbeat_at) FROM collab_sessions s
                 WHERE s.room_id = p.room_id AND s.agent_id = p.agent_id
                   AND s.status = 'active' AND s.expires_at > ?) AS last_seen
       FROM collab_participants p
       JOIN collab_agents a ON a.id = p.agent_id
       WHERE p.room_id = ?
       ORDER BY p.joined_at ASC, p.agent_id ASC`,
    )
    .all(nowIso, nowIso, room.id);
  const participants = participantRows.map((row) => participantViewFromRow(row));

  const summary = emptyTaskSummary();
  const counts = runtime.db
    .prepare(
      `SELECT status, COUNT(*) AS total
       FROM collab_tasks
       WHERE room_id = ?
       GROUP BY status`,
    )
    .all(room.id);
  for (const row of counts) {
    const status = fieldString(row, "status") as TaskStatus;
    if (TASK_STATUSES.includes(status)) {
      summary[status] = fieldNumber(row, "total");
    }
  }

  return {
    room,
    coordinator,
    self: {
      agent: actor.agent,
      roles: actor.roles,
      session: actor.session,
    },
    participants,
    taskSummary: summary,
  };
}
