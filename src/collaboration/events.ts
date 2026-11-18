import {
  asCursor,
  asIsoDateTime,
  type AgentId,
  type Cursor,
  type IsoDateTime,
  type JsonValue,
  type MessageId,
  type RoomId,
  type TaskId,
} from "../contracts/index.js";
import type { DatabaseConnection, SqlRow } from "../persistence/index.js";
import {
  fieldNumber,
  fieldOptionalString,
  fieldString,
  parseJsonObjectColumn,
  toJsonText,
} from "./rows.js";
import type { EventView, UpdatesPage } from "./types.js";
import { normalizeCursor, normalizeLimit } from "./validation.js";
import { newCollaborationId } from "./ids.js";

/**
 * Event log persistente, base do `collab_get_updates` e da auditoria de
 * operacoes. Nenhum token, convite ou hash e gravado aqui.
 *
 * Visibilidade:
 * - `room`: todos os participantes da sala;
 * - `direct`: somente ator e destinatario;
 * - `self`: somente o ator.
 */
export interface AppendEventInput {
  readonly roomId: RoomId;
  readonly type: string;
  readonly actorAgentId?: AgentId;
  readonly visibility: "room" | "direct" | "self";
  readonly targetAgentId?: AgentId;
  readonly messageId?: MessageId;
  readonly taskId?: TaskId;
  readonly requestId?: string;
  readonly handoffId?: string;
  readonly payload: Readonly<Record<string, JsonValue>>;
  readonly createdAt: string;
}

export interface AppendedEvent {
  readonly cursor: Cursor;
  readonly createdAt: IsoDateTime;
}

export function appendEvent(db: DatabaseConnection, input: AppendEventInput): AppendedEvent {
  db.prepare(
    `INSERT INTO collab_events (
       room_id, event_type, actor_agent_id, visibility, target_agent_id,
       message_id, task_id, request_id, handoff_id, payload, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.roomId,
    input.type,
    input.actorAgentId ?? null,
    input.visibility,
    input.targetAgentId ?? null,
    input.messageId ?? null,
    input.taskId ?? null,
    input.requestId ?? null,
    input.handoffId ?? null,
    toJsonText(input.payload),
    input.createdAt,
  );

  const row = db.prepare("SELECT last_insert_rowid() AS cursor").get();
  if (row === undefined) {
    throw new Error("Falha ao obter cursor do evento recem-inserido.");
  }
  return {
    cursor: asCursor(String(fieldNumber(row, "cursor"))),
    createdAt: asIsoDateTime(input.createdAt),
  };
}

function toEventView(row: SqlRow): EventView {
  const visibility = fieldString(row, "visibility");
  if (visibility !== "room" && visibility !== "direct" && visibility !== "self") {
    throw new Error("Visibilidade de evento invalida no banco.");
  }
  const payload = parseJsonObjectColumn(fieldString(row, "payload"), "payload");
  return {
    cursor: asCursor(String(fieldNumber(row, "cursor"))),
    type: fieldString(row, "event_type"),
    visibility,
    actorAgentId: fieldOptionalString(row, "actor_agent_id") as AgentId | undefined,
    targetAgentId: fieldOptionalString(row, "target_agent_id") as AgentId | undefined,
    messageId: fieldOptionalString(row, "message_id") as MessageId | undefined,
    taskId: fieldOptionalString(row, "task_id") as TaskId | undefined,
    requestId: fieldOptionalString(row, "request_id"),
    handoffId: fieldOptionalString(row, "handoff_id"),
    payload: payload as Readonly<Record<string, JsonValue>>,
    createdAt: asIsoDateTime(fieldString(row, "created_at")),
  };
}

/**
 * Consulta NAO BLOQUEANTE de eventos autorizados desde um cursor monotonico.
 * O filtro usa o agente e a sala derivados da sessao autenticada; o chamador
 * nao escolhe roomId nem agentId.
 */
export function readAuthorizedUpdates(
  db: DatabaseConnection,
  roomId: RoomId,
  agentId: AgentId,
  options: { readonly cursor?: string; readonly limit?: number } = {},
): UpdatesPage {
  const cursor = normalizeCursor(options.cursor);
  const limit = normalizeLimit(options.limit, 50, 200);

  const rows = db
    .prepare(
      `SELECT cursor, event_type, visibility, actor_agent_id, target_agent_id,
              message_id, task_id, request_id, handoff_id, payload, created_at
       FROM collab_events
       WHERE room_id = ?
         AND cursor > ?
         AND (
           visibility = 'room'
           OR (visibility = 'direct' AND (actor_agent_id = ? OR target_agent_id = ?))
           OR (visibility = 'self' AND actor_agent_id = ?)
         )
       ORDER BY cursor ASC
       LIMIT ?`,
    )
    .all(roomId, Number(cursor), agentId, agentId, agentId, limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const events = pageRows.map(toEventView);
  const lastCursor = events.length === 0 ? cursor : String(events[events.length - 1]?.cursor);

  return {
    events,
    nextCursor: asCursor(lastCursor),
    hasMore,
  };
}

export interface AuditInput {
  readonly roomId?: RoomId;
  readonly actorAgentId?: AgentId;
  readonly sessionId?: string;
  readonly operation: string;
  readonly outcome: "ok" | "denied" | "failed";
  readonly errorCode?: string;
}

/**
 * Auditoria persistente sem segredos e sem conteudo de mensagem/arquivo.
 * Falha de auditoria nunca mascara a resposta original da ferramenta.
 */
export function recordAudit(db: DatabaseConnection, input: AuditInput): void {
  db.prepare(
    `INSERT INTO collab_audit_log (
       id, room_id, actor_agent_id, session_id, operation, outcome, error_code, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newCollaborationId("audit"),
    input.roomId ?? null,
    input.actorAgentId ?? null,
    input.sessionId ?? null,
    input.operation,
    input.outcome,
    input.errorCode ?? null,
    new Date().toISOString(),
  );
}

export function safeRecordAudit(db: DatabaseConnection, input: AuditInput): void {
  try {
    recordAudit(db, input);
  } catch {
    // Auditoria e observabilidade; nao deve esconder o erro de negocio real.
  }
}
