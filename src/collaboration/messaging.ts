import {
  asAgentId,
  asIsoDateTime,
  asMessageId,
  asRoomId,
  DomainError,
  type MessageId,
  type MessageKind,
} from "../contracts/index.js";
import type { SqlRow } from "../persistence/index.js";
import type { CollaborationRuntime } from "./context.js";
import { appendEvent } from "./events.js";
import { newCollaborationId } from "./ids.js";
import {
  fieldOptionalString,
  fieldString,
} from "./rows.js";
import { requireParticipant } from "./membership.js";
import type {
  AuthenticatedActor,
  ListRequestsOptions,
  MessageView,
  RequestPlanInput,
  RequestResult,
  RequestStatus,
  RequestView,
  RespondToRequestInput,
  SendMessageInput,
  SendMessageResult,
} from "./types.js";
import {
  normalizeLimit,
  normalizeOptionalText,
  normalizeRequestStatus,
  normalizeText,
  validationError,
} from "./validation.js";

const MAX_BODY_LENGTH = 8000;

function normalizeMessageKind(value: string | undefined): "chat" | "decision" {
  if (value === undefined) return "chat";
  if (value === "chat" || value === "decision") return value;
  throw validationError(
    `Tipo de mensagem nao suportado: "${value}".`,
    "Use chat (conversa) ou decision (decisao compartilhada).",
    "kind",
  );
}

function messageView(input: {
  readonly id: MessageId;
  readonly roomId: MessageView["roomId"];
  readonly fromAgentId: MessageView["fromAgentId"];
  readonly toAgentId?: MessageView["toAgentId"];
  readonly kind: MessageKind;
  readonly correlationId?: MessageId;
  readonly body: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly cursor: MessageView["cursor"];
  readonly createdAt: string;
}): MessageView {
  return {
    id: input.id,
    roomId: input.roomId,
    fromAgentId: input.fromAgentId,
    toAgentId: input.toAgentId,
    kind: input.kind,
    correlationId: input.correlationId,
    body: input.body,
    payload: input.payload as MessageView["payload"],
    cursor: input.cursor,
    createdAt: asIsoDateTime(input.createdAt),
  };
}

export function sendMessage(
  runtime: CollaborationRuntime,
  actor: AuthenticatedActor,
  input: SendMessageInput,
): SendMessageResult {
  const body = normalizeText(input.body, "body", 1, MAX_BODY_LENGTH);
  const kind = normalizeMessageKind(input.kind);
  let toAgentId: MessageView["toAgentId"];
  if (input.toAgentId !== undefined) {
    const targetText = normalizeText(input.toAgentId, "toAgentId", 1, 100);
    const target = asAgentId(targetText);
    if (target === actor.agent.id) {
      throw validationError(
        "Mensagem direta para o proprio agente nao e util.",
        "Omita toAgentId para falar com a sala ou escolha outro participante.",
        "toAgentId",
      );
    }
    requireParticipant(runtime.db, actor.room.id, target);
    toAgentId = target;
  }

  const now = runtime.now();
  const nowIso = now.toISOString();
  const messageId = asMessageId(newCollaborationId("message"));

  const event = runtime.db.transaction(() => {
    runtime.db
      .prepare(
        `INSERT INTO collab_messages (
           id, room_id, from_agent_id, to_agent_id, kind, correlation_id, body, payload, created_at
         ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?)`,
      )
      .run(messageId, actor.room.id, actor.agent.id, toAgentId ?? null, kind, body, nowIso);

    return appendEvent(runtime.db, {
      roomId: actor.room.id,
      type: "message.sent",
      actorAgentId: actor.agent.id,
      visibility: toAgentId === undefined ? "room" : "direct",
      targetAgentId: toAgentId,
      messageId,
      payload: {
        messageId: String(messageId),
        kind,
        body,
        ...(toAgentId === undefined ? {} : { toAgentId: String(toAgentId) }),
      },
      createdAt: nowIso,
    });
  });

  return {
    message: messageView({
      id: messageId,
      roomId: actor.room.id,
      fromAgentId: actor.agent.id,
      toAgentId,
      kind,
      body,
      cursor: event.cursor,
      createdAt: asIsoDateTime(nowIso),
    }),
  };
}

export function requestPlan(
  runtime: CollaborationRuntime,
  actor: AuthenticatedActor,
  input: RequestPlanInput,
): RequestResult {
  if (actor.isCoordinator) {
    throw new DomainError("INVALID_STATE", "O coordinator nao solicita plano a si mesmo.", {
      hint: "Use collab_propose_task para distribuir o trabalho ou aguarde solicitacoes dos workers.",
      context: { roomId: actor.room.id },
    });
  }
  const coordinatorAgentId = actor.room.coordinatorAgentId;
  requireParticipant(runtime.db, actor.room.id, coordinatorAgentId);

  const subject = normalizeText(input.subject, "subject", 1, 200);
  const details = normalizeOptionalText(input.details, "details", MAX_BODY_LENGTH);
  const body = details === undefined ? subject : `${subject}\n\n${details}`;

  const now = runtime.now();
  const nowIso = now.toISOString();
  const messageId = asMessageId(newCollaborationId("message"));
  const requestId = newCollaborationId("request");

  const event = runtime.db.transaction(() => {
    runtime.db
      .prepare(
        `INSERT INTO collab_messages (
           id, room_id, from_agent_id, to_agent_id, kind, correlation_id, body, payload, created_at
         ) VALUES (?, ?, ?, ?, 'request', NULL, ?, NULL, ?)`,
      )
      .run(messageId, actor.room.id, actor.agent.id, coordinatorAgentId, body, nowIso);

    runtime.db
      .prepare(
        `INSERT INTO collab_requests (
           id, room_id, from_agent_id, to_agent_id, kind, subject, details, status,
           request_message_id, response_message_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'plan', ?, ?, 'open', ?, NULL, ?, ?)`,
      )
      .run(
        requestId,
        actor.room.id,
        actor.agent.id,
        coordinatorAgentId,
        subject,
        details ?? null,
        messageId,
        nowIso,
        nowIso,
      );

    return appendEvent(runtime.db, {
      roomId: actor.room.id,
      type: "request.created",
      actorAgentId: actor.agent.id,
      visibility: "direct",
      targetAgentId: coordinatorAgentId,
      messageId,
      requestId,
      payload: {
        requestId,
        requestMessageId: String(messageId),
        kind: "plan",
        subject,
        ...(details === undefined ? {} : { details }),
        body,
        fromAgentId: String(actor.agent.id),
        toAgentId: String(coordinatorAgentId),
      },
      createdAt: nowIso,
    });
  });

  const message = messageView({
    id: messageId,
    roomId: actor.room.id,
    fromAgentId: actor.agent.id,
    toAgentId: coordinatorAgentId,
    kind: "request",
    body,
    cursor: event.cursor,
    createdAt: asIsoDateTime(nowIso),
  });

  return {
    request: {
      id: requestId,
      roomId: actor.room.id,
      fromAgentId: actor.agent.id,
      toAgentId: coordinatorAgentId,
      kind: "plan",
      status: "open",
      subject,
      details,
      requestMessageId: messageId,
      createdAt: asIsoDateTime(nowIso),
      updatedAt: asIsoDateTime(nowIso),
    },
    message,
  };
}

export function respondToRequest(
  runtime: CollaborationRuntime,
  actor: AuthenticatedActor,
  input: RespondToRequestInput,
): RequestResult {
  const requestId = normalizeText(input.requestId, "requestId", 1, 100);
  const body = normalizeText(input.body, "body", 1, MAX_BODY_LENGTH);

  const row = runtime.db
    .prepare("SELECT * FROM collab_requests WHERE id = ? AND room_id = ?")
    .get(requestId, actor.room.id);
  if (row === undefined) {
    throw new DomainError("NOT_FOUND", "Solicitacao nao encontrada nesta sala.", {
      hint: "Use um requestId retornado por collab_request_plan.",
      context: { requestId },
    });
  }

  const fromAgentId = asAgentId(fieldString(row, "from_agent_id"));
  const toAgentId = asAgentId(fieldString(row, "to_agent_id"));

  // O destinatario original ou o coordinator ATUAL (derivado da sala) pode
  // responder; nenhum outro participante recebe essa autoridade.
  if (actor.agent.id !== toAgentId && !actor.isCoordinator) {
    throw new DomainError("FORBIDDEN", "Somente o destinatario da solicitacao pode responde-la.", {
      hint: "Aguarde o coordinator da sala responder ou crie sua propria solicitacao.",
      context: { requestId },
    });
  }

  const status = fieldString(row, "status") as RequestStatus;
  if (status !== "open") {
    throw new DomainError("INVALID_STATE", "Solicitacao ja foi respondida ou encerrada.", {
      hint: "Crie uma nova solicitacao se precisar de outro plano.",
      context: { requestId, status },
    });
  }

  const requestMessageId = asMessageId(fieldString(row, "request_message_id"));
  const now = runtime.now();
  const nowIso = now.toISOString();
  const responseMessageId = asMessageId(newCollaborationId("message"));

  const event = runtime.db.transaction(() => {
    runtime.db
      .prepare(
        `INSERT INTO collab_messages (
           id, room_id, from_agent_id, to_agent_id, kind, correlation_id, body, payload, created_at
         ) VALUES (?, ?, ?, ?, 'response', ?, ?, NULL, ?)`,
      )
      .run(
        responseMessageId,
        actor.room.id,
        actor.agent.id,
        fromAgentId,
        requestMessageId,
        body,
        nowIso,
      );

    const updated = runtime.db
      .prepare(
        `UPDATE collab_requests
         SET status = 'answered', response_message_id = ?, updated_at = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(responseMessageId, nowIso, requestId);
    if (updated.changes !== 1) {
      throw new DomainError("CONFLICT", "Solicitacao respondida por outra chamada concorrente.", {
        hint: "Consulte collab_list_requests para ver a resposta registrada.",
        context: { requestId },
      });
    }

    return appendEvent(runtime.db, {
      roomId: actor.room.id,
      type: "request.answered",
      actorAgentId: actor.agent.id,
      visibility: "direct",
      targetAgentId: fromAgentId,
      messageId: responseMessageId,
      requestId,
      payload: {
        requestId,
        requestMessageId: String(requestMessageId),
        responseMessageId: String(responseMessageId),
        body,
        fromAgentId: String(actor.agent.id),
        toAgentId: String(fromAgentId),
      },
      createdAt: nowIso,
    });
  });

  const details = fieldOptionalString(row, "details");
  const subject = fieldString(row, "subject");
  return {
    request: {
      id: requestId,
      roomId: actor.room.id,
      fromAgentId,
      toAgentId,
      kind: "plan",
      status: "answered",
      subject,
      details,
      requestMessageId,
      responseMessageId,
      responseBody: body,
      createdAt: asIsoDateTime(fieldString(row, "created_at")),
      updatedAt: asIsoDateTime(nowIso),
    },
    message: messageView({
      id: responseMessageId,
      roomId: actor.room.id,
      fromAgentId: actor.agent.id,
      toAgentId: fromAgentId,
      kind: "response",
      correlationId: requestMessageId,
      body,
      cursor: event.cursor,
      createdAt: asIsoDateTime(nowIso),
    }),
  };
}

function toRequestView(row: SqlRow): RequestView {
  const responseBody = fieldOptionalString(row, "response_body");
  const responseMessageIdRaw = fieldOptionalString(row, "response_message_id");
  return {
    id: fieldString(row, "id"),
    roomId: asRoomId(fieldString(row, "room_id")),
    fromAgentId: asAgentId(fieldString(row, "from_agent_id")),
    toAgentId: asAgentId(fieldString(row, "to_agent_id")),
    kind: fieldString(row, "kind") as RequestView["kind"],
    status: fieldString(row, "status") as RequestStatus,
    subject: fieldString(row, "subject"),
    details: fieldOptionalString(row, "details"),
    requestMessageId: asMessageId(fieldString(row, "request_message_id")),
    responseMessageId:
      responseMessageIdRaw === undefined ? undefined : asMessageId(responseMessageIdRaw),
    responseBody,
    createdAt: asIsoDateTime(fieldString(row, "created_at")),
    updatedAt: asIsoDateTime(fieldString(row, "updated_at")),
  };
}

export function listRequests(
  runtime: CollaborationRuntime,
  actor: AuthenticatedActor,
  options: ListRequestsOptions = {},
): readonly RequestView[] {
  const limit = normalizeLimit(options.limit, 100, 200);
  const status =
    options.status === undefined ? undefined : normalizeRequestStatus(options.status);

  const clauses = ["r.room_id = ?"];
  const params: (string | number)[] = [actor.room.id];
  if (!actor.isCoordinator) {
    clauses.push("(r.from_agent_id = ? OR r.to_agent_id = ?)");
    params.push(actor.agent.id, actor.agent.id);
  }
  if (status !== undefined) {
    clauses.push("r.status = ?");
    params.push(status);
  }
  params.push(limit);

  const rows = runtime.db
    .prepare(
      `SELECT r.*, resp.body AS response_body
       FROM collab_requests r
       LEFT JOIN collab_messages resp ON resp.id = r.response_message_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT ?`,
    )
    .all(...params);

  return rows.map(toRequestView);
}
