import {
  asAgentId,
  asIsoDateTime,
  asRoomId,
  asSessionId,
  asWorkspaceId,
  DomainError,
  type PrincipalId,
  type Role,
} from "../contracts/index.js";
import type { DatabaseConnection, SqlRow } from "../persistence/index.js";
import {
  fieldBoolean,
  fieldOptionalString,
  fieldString,
  parseRolesColumn,
} from "./rows.js";
import type {
  AgentView,
  AuthenticatedActor,
  ParticipantIdentity,
  RoomView,
  SessionView,
} from "./types.js";
import { hashCollaborationSecret, isPlausibleSecret } from "./tokens.js";
import { uniqueRoles } from "./membership.js";

/**
 * API PUBLICA de autenticacao consumida pelo modulo de workspace/locking e
 * pelas ferramentas.
 *
 * A sala, o participante e os papeis vem do banco; o chamador fornece apenas o
 * token secreto. Expirar/revogar e detectado a cada chamada, com marcacao lazy
 * de `expired` no banco. A leitura NAO renova heartbeat (isso e explicito em
 * `collab_heartbeat`) para manter a semantica de expiracao simples e testavel.
 */
export interface AuthenticateCollaborationOptions {
  readonly now?: () => Date;
  /**
   * Principal autenticado no TRANSPORTE. OBRIGATORIO: uma sessao de sala so
   * e valida para o principal que a criou/ingressou. Nunca e aceito de
   * argumentos da tool; o servico injeta a partir do contexto autenticado.
   */
  readonly principalId: PrincipalId;
}

type SessionInactiveReason = "invalid" | "expired" | "revoked" | "removed";

export function sessionInactiveError(reason: SessionInactiveReason): DomainError {
  switch (reason) {
    case "expired":
      return new DomainError("SESSION_INACTIVE", "Sessao de colaboracao expirada.", {
        hint: "Envie collab_heartbeat enquanto a sessao estiver ativa ou entre novamente na sala com um novo convite.",
        context: { reason },
      });
    case "revoked":
      return new DomainError("SESSION_INACTIVE", "Sessao de colaboracao revogada.", {
        hint: "Entre novamente na sala com um novo convite para obter outra sessao.",
        context: { reason },
      });
    case "removed":
      return new DomainError("SESSION_INACTIVE", "Participante nao esta mais ativo na sala.", {
        hint: "Solicite um novo convite ao coordinator da sala.",
        context: { reason },
      });
    case "invalid":
    default:
      return new DomainError("SESSION_INACTIVE", "Sessao de colaboracao invalida ou desconhecida.", {
        hint: "Use o token retornado por collab_create_room ou collab_join_room; se o perdeu, entre novamente com um novo convite.",
        context: { reason: "invalid" },
      });
  }
}

function toSessionView(row: SqlRow): SessionView {
  return {
    id: asSessionId(fieldString(row, "session_id")),
    roomId: asRoomId(fieldString(row, "session_room_id")),
    agentId: asAgentId(fieldString(row, "session_agent_id")),
    status: fieldString(row, "status") as SessionView["status"],
    createdAt: asIsoDateTime(fieldString(row, "session_created_at")),
    lastHeartbeatAt: asIsoDateTime(fieldString(row, "last_heartbeat_at")),
    expiresAt: asIsoDateTime(fieldString(row, "expires_at")),
    revokedAt:
      row["revoked_at"] === null || row["revoked_at"] === undefined
        ? undefined
        : asIsoDateTime(fieldString(row, "revoked_at")),
  };
}

interface AuthRow {
  readonly row: SqlRow;
}

function queryAuthRow(db: DatabaseConnection, tokenHash: string): AuthRow | undefined {
  const row = db
    .prepare(
      `SELECT
         s.id                AS session_id,
         s.room_id           AS session_room_id,
         s.agent_id          AS session_agent_id,
         s.status            AS status,
         s.created_at        AS session_created_at,
         s.last_heartbeat_at AS last_heartbeat_at,
         s.expires_at        AS expires_at,
         s.revoked_at        AS revoked_at,
         s.principal_id      AS session_principal_id,
         a.id                AS agent_id,
         a.display_name      AS display_name,
         a.client_kind       AS client_kind,
         a.created_at        AS agent_created_at,
         r.id                AS room_id,
         r.name              AS room_name,
         r.workspace_id      AS workspace_id,
         r.coordinator_agent_id AS coordinator_agent_id,
         r.created_by_agent_id  AS created_by_agent_id,
         r.created_at           AS room_created_at,
         p.roles             AS participant_roles,
         p.active            AS participant_active,
         p.joined_at         AS participant_joined_at
       FROM collab_sessions s
       JOIN collab_agents a ON a.id = s.agent_id
       JOIN collab_rooms r ON r.id = s.room_id
       JOIN collab_participants p
         ON p.room_id = s.room_id AND p.agent_id = s.agent_id
       WHERE s.token_hash = ?`,
    )
    .get(tokenHash);
  return row === undefined ? undefined : { row };
}

export function authenticateCollaborationSession(
  db: DatabaseConnection,
  sessionToken: string,
  options: AuthenticateCollaborationOptions,
): AuthenticatedActor {
  if (!isPlausibleSecret(sessionToken) || sessionToken.trim() !== sessionToken) {
    throw sessionInactiveError("invalid");
  }

  const found = queryAuthRow(db, hashCollaborationSecret(sessionToken));
  if (found === undefined) {
    throw sessionInactiveError("invalid");
  }

  const row = found.row;
  const session = toSessionView(row);
  const now = (options.now ?? (() => new Date()))();
  const nowMs = now.getTime();

  if (session.status === "revoked") {
    throw sessionInactiveError("revoked");
  }
  if (session.status === "expired") {
    throw sessionInactiveError("expired");
  }
  if (Date.parse(session.expiresAt) <= nowMs) {
    db.prepare(
      `UPDATE collab_sessions SET status = 'expired'
       WHERE id = ? AND status = 'active'`,
    ).run(session.id);
    throw sessionInactiveError("expired");
  }

  const participantActive = fieldBoolean(row, "participant_active");
  if (!participantActive) {
    throw sessionInactiveError("removed");
  }

  // VINCULO DE TRANSPORTE: mesmo que o sessionToken vaze, outro principal
  // nao pode usa-lo. Sessoes legadas (principal_id NULL) ficam inacessiveis.
  const sessionPrincipalId = fieldOptionalString(row, "session_principal_id");
  if (sessionPrincipalId !== String(options.principalId)) {
    throw new DomainError(
      "FORBIDDEN",
      "Esta sessao de sala pertence a outra credencial de transporte.",
      {
        hint:
          "Use a credencial Bearer que criou esta sala ou que ingressou com o convite. " +
          "Se o sessionToken vazou, encerre com collab_leave e entre novamente com um novo convite.",
        context: { reason: "principal_mismatch" },
      },
    );
  }

  const agent: AgentView = {
    id: asAgentId(fieldString(row, "agent_id")),
    displayName: fieldString(row, "display_name"),
    clientKind: fieldString(row, "client_kind"),
    createdAt: asIsoDateTime(fieldString(row, "agent_created_at")),
  };

  const room: RoomView = {
    id: asRoomId(fieldString(row, "room_id")),
    name: fieldString(row, "room_name"),
    workspaceId: asWorkspaceId(fieldString(row, "workspace_id")),
    coordinatorAgentId: asAgentId(fieldString(row, "coordinator_agent_id")),
    createdByAgentId: asAgentId(fieldString(row, "created_by_agent_id")),
    createdAt: asIsoDateTime(fieldString(row, "room_created_at")),
  };

  const storedRoles = parseRolesColumn(fieldString(row, "participant_roles"));
  const isCoordinator = room.coordinatorAgentId === agent.id;

  // A sala e a fonte de verdade do coordinator; papeis sao normalizados para
  // nunca conceder coordinator a quem a sala nao aponta.
  const roles: readonly Role[] = uniqueRoles(
    isCoordinator
      ? storedRoles.includes("coordinator")
        ? storedRoles
        : [...storedRoles, "coordinator"]
      : storedRoles.filter((role) => role !== "coordinator"),
  );
  if (roles.length === 0) {
    throw new DomainError("INTERNAL", "Participante sem papeis validos.", {
      hint: "Verifique a integridade da sala e dos participantes.",
      context: { roomId: room.id, agentId: agent.id },
    });
  }

  const participant: ParticipantIdentity = {
    roomId: room.id,
    agentId: agent.id,
    roles,
    active: true,
    joinedAt: asIsoDateTime(fieldString(row, "participant_joined_at")),
  };

  return {
    session,
    agent,
    room,
    participant,
    roles,
    isCoordinator,
  };
}
