import {
  asAgentId,
  asIsoDateTime,
  asMessageId,
  asRoomId,
  asTaskId,
  DomainError,
  type AgentId,
  type MessageId,
  type TaskId,
  type TaskStatus,
} from "../contracts/index.js";
import type { SqlRow } from "../persistence/index.js";
import type { CollaborationRuntime } from "./context.js";
import { appendEvent } from "./events.js";
import { newCollaborationId } from "./ids.js";
import {
  fieldOptionalString,
  fieldString,
} from "./rows.js";
import { requireCoordinator, requireParticipant } from "./membership.js";
import {
  evaluateHandoffSufficiency,
  findLatestHandoff,
} from "./handoffs.js";
import type {
  AuthenticatedActor,
  ListTasksOptions,
  MessageView,
  ProposeTaskInput,
  TaskAction,
  TaskUpdateResult,
  TaskView,
  UpdateTaskInput,
  AssignTaskInput,
} from "./types.js";
import {
  normalizeLimit,
  normalizeOptionalText,
  normalizeTaskAction,
  normalizeTaskStatus,
  normalizeText,
  validationError,
} from "./validation.js";

/**
 * Transicoes explicitas (nenhuma mudanca de status acontece "por acaso"):
 *
 * proposed  -> accepted  (assignee, accept)
 * proposed  -> cancelled (coordinator, cancel)
 * accepted  -> in_progress (assignee, start; exige dependencias completed)
 * accepted  -> cancelled (coordinator, cancel)
 * in_progress -> blocked (assignee, block; exige nota)
 * in_progress -> completed (assignee, complete; exige handoff suficiente)
 * in_progress -> cancelled (coordinator, cancel)
 * blocked -> in_progress (assignee, unblock; revalida dependencias)
 * blocked -> cancelled (coordinator, cancel)
 *
 * `progress` nao muda status; registra mensagem e evento. Reatribuicao pelo
 * coordinator volta para proposed e exige novo aceite. Coordinator nao executa
 * a tarefa de outro agente.
 */
const ACTIONS_REQUIRING_ASSIGNEE: readonly TaskAction[] = [
  "accept",
  "start",
  "block",
  "unblock",
  "progress",
  "complete",
];

function assertTaskInRoom(
  runtime: CollaborationRuntime,
  actor: AuthenticatedActor,
  taskId: TaskId,
): SqlRow {
  const row = runtime.db
    .prepare("SELECT * FROM collab_tasks WHERE id = ? AND room_id = ?")
    .get(taskId, actor.room.id);
  if (row === undefined) {
    throw new DomainError("NOT_FOUND", "Tarefa nao encontrada nesta sala.", {
      hint: "Use um taskId retornado por collab_list_tasks.",
      context: { taskId },
    });
  }
  return row;
}

function loadDependencies(
  runtime: CollaborationRuntime,
  taskId: TaskId,
): readonly TaskId[] {
  return runtime.db
    .prepare(
      `SELECT depends_on_task_id FROM collab_task_dependencies
       WHERE task_id = ? ORDER BY depends_on_task_id ASC`,
    )
    .all(taskId)
    .map((row) => asTaskId(fieldString(row, "depends_on_task_id")));
}

function toTaskView(
  row: SqlRow,
  dependsOn: readonly TaskId[],
): TaskView {
  const blockedReason = fieldOptionalString(row, "blocked_reason");
  const completedAt = fieldOptionalString(row, "completed_at");
  const latestHandoffId = fieldOptionalString(row, "latest_handoff_id");
  return {
    id: asTaskId(fieldString(row, "id")),
    roomId: asRoomId(fieldString(row, "room_id")),
    title: fieldString(row, "title"),
    description: fieldOptionalString(row, "description"),
    status: fieldString(row, "status") as TaskStatus,
    assigneeAgentId: fieldOptionalString(row, "assignee_agent_id") as
      | AgentId
      | undefined,
    createdByAgentId: asAgentId(fieldString(row, "created_by_agent_id")),
    dependsOn,
    blockedReason,
    createdAt: asIsoDateTime(fieldString(row, "created_at")),
    updatedAt: asIsoDateTime(fieldString(row, "updated_at")),
    completedAt: completedAt === undefined ? undefined : asIsoDateTime(completedAt),
    handoffCount: Number(row["handoff_count"] ?? 0),
    latestHandoffId,
  };
}

export function loadTaskView(
  runtime: CollaborationRuntime,
  taskId: TaskId,
): TaskView {
  const row = runtime.db
    .prepare(
      `SELECT t.*,
              (SELECT COUNT(*) FROM collab_handoffs h WHERE h.task_id = t.id) AS handoff_count,
              (SELECT h.id FROM collab_handoffs h
                 WHERE h.task_id = t.id
                 ORDER BY h.created_at DESC, h.rowid DESC LIMIT 1) AS latest_handoff_id
       FROM collab_tasks t
       WHERE t.id = ?`,
    )
    .get(taskId);
  if (row === undefined) {
    throw new DomainError("NOT_FOUND", "Tarefa nao encontrada.", {
      hint: "Use um taskId retornado por collab_list_tasks.",
      context: { taskId },
    });
  }
  return toTaskView(row, loadDependencies(runtime, taskId));
}

function invalidTransition(
  taskId: TaskId,
  current: TaskStatus,
  action: TaskAction,
): never {
  throw new DomainError(
    "INVALID_STATE",
    `Acao "${action}" invalida para tarefa em "${current}".`,
    {
      hint:
        current === "proposed"
          ? "O agente atribuido deve usar accept antes de iniciar."
          : current === "accepted"
            ? "Use start para iniciar ou cancel (coordinator) para encerrar."
            : current === "in_progress"
              ? "Use block, progress, complete ou cancel (coordinator)."
              : current === "blocked"
                ? "Use unblock para retomar ou cancel (coordinator)."
                : "Tarefas completed/cancelled sao terminais.",
      context: { taskId, current, action },
    },
  );
}

function buildMessageView(input: {
  readonly id: MessageId;
  readonly roomId: TaskView["roomId"];
  readonly fromAgentId: AgentId;
  readonly kind: "progress" | "blocker";
  readonly body: string;
  readonly cursor: MessageView["cursor"];
  readonly createdAt: string;
}): MessageView {
  return {
    id: input.id,
    roomId: input.roomId,
    fromAgentId: input.fromAgentId,
    kind: input.kind,
    body: input.body,
    cursor: input.cursor,
    createdAt: asIsoDateTime(input.createdAt),
  };
}

function insertTaskMessage(
  runtime: CollaborationRuntime,
  actor: AuthenticatedActor,
  kind: "progress" | "blocker",
  body: string,
  nowIso: string,
): { readonly id: MessageId; readonly body: string } {
  const id = asMessageId(newCollaborationId("message"));
  runtime.db
    .prepare(
      `INSERT INTO collab_messages (
         id, room_id, from_agent_id, to_agent_id, kind, correlation_id, body, payload, created_at
       ) VALUES (?, ?, ?, NULL, ?, NULL, ?, NULL, ?)`,
    )
    .run(id, actor.room.id, actor.agent.id, kind, body, nowIso);
  return { id, body };
}

function assertDependenciesCompleted(
  runtime: CollaborationRuntime,
  taskId: TaskId,
): void {
  const dependencies = runtime.db
    .prepare(
      `SELECT d.depends_on_task_id, t.status
       FROM collab_task_dependencies d
       JOIN collab_tasks t ON t.id = d.depends_on_task_id
       WHERE d.task_id = ?`,
    )
    .all(taskId);
  const pending = dependencies
    .filter((row) => fieldString(row, "status") !== "completed")
    .map((row) => fieldString(row, "depends_on_task_id"));
  if (pending.length > 0) {
    throw new DomainError("INVALID_STATE", "Dependencias da tarefa ainda nao foram concluidas.", {
      hint:
        "Dependencias pendentes devem ser concluidas antes do start; " +
        "aguarde as tarefas em dependsOn ou peca ao coordinator para revisar a divisao.",
      context: { taskId, pending },
    });
  }
}

export function proposeTask(
  runtime: CollaborationRuntime,
  actor: AuthenticatedActor,
  input: ProposeTaskInput,
): TaskView {
  requireCoordinator(actor);
  const title = normalizeText(input.title, "title", 1, 200);
  const description = normalizeOptionalText(input.description, "description", 8000);

  let assigneeAgentId: AgentId | undefined;
  if (input.assigneeAgentId !== undefined) {
    assigneeAgentId = asAgentId(
      normalizeText(input.assigneeAgentId, "assigneeAgentId", 1, 100),
    );
    requireParticipant(runtime.db, actor.room.id, assigneeAgentId);
  }

  const dependsOnInput = input.dependsOn ?? [];
  if (dependsOnInput.length > 20) {
    throw validationError(
      'Campo "dependsOn" excede 20 tarefas.',
      "Divida o trabalho em menos dependencias diretas.",
      "dependsOn",
    );
  }
  const dependsOn: TaskId[] = [];
  for (const value of dependsOnInput) {
    const dependencyId = asTaskId(normalizeText(value, "dependsOn[]", 1, 100));
    if (!dependsOn.includes(dependencyId)) dependsOn.push(dependencyId);
  }
  for (const dependencyId of dependsOn) {
    const row = runtime.db
      .prepare("SELECT id FROM collab_tasks WHERE id = ? AND room_id = ?")
      .get(dependencyId, actor.room.id);
    if (row === undefined) {
      throw new DomainError("NOT_FOUND", "Dependencia nao encontrada nesta sala.", {
        hint: "Use taskIds retornados por collab_list_tasks.",
        context: { dependencyId },
      });
    }
  }

  const now = runtime.now();
  const nowIso = now.toISOString();
  const taskId = asTaskId(newCollaborationId("task"));

  runtime.db.transaction(() => {
    runtime.db
      .prepare(
        `INSERT INTO collab_tasks (
           id, room_id, title, description, status, assignee_agent_id,
           created_by_agent_id, blocked_reason, created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, 'proposed', ?, ?, NULL, ?, ?, NULL)`,
      )
      .run(
        taskId,
        actor.room.id,
        title,
        description ?? null,
        assigneeAgentId ?? null,
        actor.agent.id,
        nowIso,
        nowIso,
      );

    const insertDependency = runtime.db.prepare(
      `INSERT INTO collab_task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)`,
    );
    for (const dependencyId of dependsOn) {
      insertDependency.run(taskId, dependencyId);
    }

    appendEvent(runtime.db, {
      roomId: actor.room.id,
      type: "task.proposed",
      actorAgentId: actor.agent.id,
      visibility: "room",
      taskId,
      payload: {
        taskId: String(taskId),
        title,
        status: "proposed",
        ...(assigneeAgentId === undefined
          ? {}
          : { assigneeAgentId: String(assigneeAgentId) }),
        dependsOn: dependsOn.map(String),
        createdByAgentId: String(actor.agent.id),
      },
      createdAt: nowIso,
    });
  });

  return loadTaskView(runtime, taskId);
}

export function assignTask(
  runtime: CollaborationRuntime,
  actor: AuthenticatedActor,
  input: AssignTaskInput,
): TaskView {
  requireCoordinator(actor);
  const taskId = asTaskId(normalizeText(input.taskId, "taskId", 1, 100));
  const row = assertTaskInRoom(runtime, actor, taskId);
  const currentStatus = fieldString(row, "status") as TaskStatus;
  if (currentStatus === "completed" || currentStatus === "cancelled") {
    throw new DomainError("INVALID_STATE", "Tarefa terminal nao pode ser reatribuida.", {
      hint: "Crie uma nova tarefa para o trabalho restante.",
      context: { taskId, status: currentStatus },
    });
  }

  const assigneeAgentId = asAgentId(
    normalizeText(input.assigneeAgentId, "assigneeAgentId", 1, 100),
  );
  requireParticipant(runtime.db, actor.room.id, assigneeAgentId);
  const previousAssignee = fieldOptionalString(row, "assignee_agent_id");

  if (
    previousAssignee === assigneeAgentId &&
    (currentStatus === "proposed" || currentStatus === "accepted" || currentStatus === "in_progress" || currentStatus === "blocked")
  ) {
    // Atribuicao ao mesmo agente nao reinicia progresso nem duplica eventos.
    return loadTaskView(runtime, taskId);
  }

  const now = runtime.now();
  const nowIso = now.toISOString();
  runtime.db.transaction(() => {
    runtime.db
      .prepare(
        `UPDATE collab_tasks
         SET assignee_agent_id = ?, status = 'proposed', blocked_reason = NULL,
             completed_at = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(assigneeAgentId, nowIso, taskId);

    appendEvent(runtime.db, {
      roomId: actor.room.id,
      type: "task.assigned",
      actorAgentId: actor.agent.id,
      visibility: "room",
      taskId,
      payload: {
        taskId: String(taskId),
        assigneeAgentId: String(assigneeAgentId),
        ...(previousAssignee === undefined
          ? {}
          : { previousAssigneeAgentId: previousAssignee }),
        status: "proposed",
      },
      createdAt: nowIso,
    });
  });

  return loadTaskView(runtime, taskId);
}

export function updateTask(
  runtime: CollaborationRuntime,
  actor: AuthenticatedActor,
  input: UpdateTaskInput,
): TaskUpdateResult {
  const taskId = asTaskId(normalizeText(input.taskId, "taskId", 1, 100));
  const action = normalizeTaskAction(input.action);
  const row = assertTaskInRoom(runtime, actor, taskId);
  const currentStatus = fieldString(row, "status") as TaskStatus;
  const assignee = fieldOptionalString(row, "assignee_agent_id") as AgentId | undefined;
  const now = runtime.now();
  const nowIso = now.toISOString();

  if (action === "cancel") {
    requireCoordinator(actor);
    if (currentStatus === "completed" || currentStatus === "cancelled") {
      throw invalidTransition(taskId, currentStatus, action);
    }
    const reason = normalizeOptionalText(input.reason ?? input.note, "reason", 2000);
    runtime.db.transaction(() => {
      runtime.db
        .prepare(
          `UPDATE collab_tasks
           SET status = 'cancelled', blocked_reason = NULL, completed_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(nowIso, taskId);
      appendEvent(runtime.db, {
        roomId: actor.room.id,
        type: "task.cancelled",
        actorAgentId: actor.agent.id,
        visibility: "room",
        taskId,
        payload: {
          taskId: String(taskId),
          status: "cancelled",
          cancelledByAgentId: String(actor.agent.id),
          ...(reason === undefined ? {} : { reason }),
        },
        createdAt: nowIso,
      });
    });
    return { task: loadTaskView(runtime, taskId) };
  }

  if (!ACTIONS_REQUIRING_ASSIGNEE.includes(action)) {
    throw invalidTransition(taskId, currentStatus, action);
  }
  if (assignee === undefined) {
    throw new DomainError("INVALID_STATE", "Tarefa sem agente atribuido.", {
      hint: "Peca ao coordinator para atribuir a tarefa antes de atualizar o progresso.",
      context: { taskId },
    });
  }
  if (assignee !== actor.agent.id) {
    throw new DomainError(
      "FORBIDDEN",
      "Somente o agente atribuido pode atualizar esta tarefa.",
      {
        hint: "Peca ao coordinator para reatribuir a tarefa se precisar transferir a execucao.",
        context: { taskId, assigneeAgentId: assignee },
      },
    );
  }

  switch (action) {
    case "accept": {
      if (currentStatus !== "proposed") {
        throw invalidTransition(taskId, currentStatus, action);
      }
      runtime.db.transaction(() => {
        runtime.db
          .prepare("UPDATE collab_tasks SET status = 'accepted', updated_at = ? WHERE id = ?")
          .run(nowIso, taskId);
        appendEvent(runtime.db, {
          roomId: actor.room.id,
          type: "task.status_changed",
          actorAgentId: actor.agent.id,
          visibility: "room",
          taskId,
          payload: {
            taskId: String(taskId),
            status: "accepted",
            action,
            assigneeAgentId: String(actor.agent.id),
          },
          createdAt: nowIso,
        });
      });
      break;
    }
    case "start": {
      if (currentStatus !== "accepted") {
        throw invalidTransition(taskId, currentStatus, action);
      }
      assertDependenciesCompleted(runtime, taskId);
      runtime.db.transaction(() => {
        runtime.db
          .prepare(
            `UPDATE collab_tasks
             SET status = 'in_progress', blocked_reason = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(nowIso, taskId);
        appendEvent(runtime.db, {
          roomId: actor.room.id,
          type: "task.status_changed",
          actorAgentId: actor.agent.id,
          visibility: "room",
          taskId,
          payload: {
            taskId: String(taskId),
            status: "in_progress",
            action,
            assigneeAgentId: String(actor.agent.id),
          },
          createdAt: nowIso,
        });
      });
      break;
    }
    case "block": {
      if (currentStatus !== "in_progress") {
        throw invalidTransition(taskId, currentStatus, action);
      }
      const reason = normalizeText(input.note ?? input.reason ?? "", "note", 1, 2000);
      const result = runtime.db.transaction(() => {
        const inserted = insertTaskMessage(runtime, actor, "blocker", reason, nowIso);
        runtime.db
          .prepare(
            `UPDATE collab_tasks
             SET status = 'blocked', blocked_reason = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(reason, nowIso, taskId);
        const event = appendEvent(runtime.db, {
          roomId: actor.room.id,
          type: "task.blocked",
          actorAgentId: actor.agent.id,
          visibility: "room",
          taskId,
          messageId: inserted.id,
          payload: {
            taskId: String(taskId),
            status: "blocked",
            action,
            reason,
            messageId: String(inserted.id),
            assigneeAgentId: String(actor.agent.id),
          },
          createdAt: nowIso,
        });
        return { inserted, event };
      });
      return {
        task: loadTaskView(runtime, taskId),
        message: buildMessageView({
          id: result.inserted.id,
          roomId: actor.room.id,
          fromAgentId: actor.agent.id,
          kind: "blocker",
          body: result.inserted.body,
          cursor: result.event.cursor,
          createdAt: asIsoDateTime(nowIso),
        }),
      };
    }
    case "unblock": {
      if (currentStatus !== "blocked") {
        throw invalidTransition(taskId, currentStatus, action);
      }
      assertDependenciesCompleted(runtime, taskId);
      runtime.db.transaction(() => {
        runtime.db
          .prepare(
            `UPDATE collab_tasks
             SET status = 'in_progress', blocked_reason = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(nowIso, taskId);
        appendEvent(runtime.db, {
          roomId: actor.room.id,
          type: "task.status_changed",
          actorAgentId: actor.agent.id,
          visibility: "room",
          taskId,
          payload: {
            taskId: String(taskId),
            status: "in_progress",
            action,
            assigneeAgentId: String(actor.agent.id),
          },
          createdAt: nowIso,
        });
      });
      break;
    }
    case "progress": {
      if (currentStatus !== "accepted" && currentStatus !== "in_progress" && currentStatus !== "blocked") {
        throw invalidTransition(taskId, currentStatus, action);
      }
      const note = normalizeText(input.note ?? "", "note", 1, 4000);
      const result = runtime.db.transaction(() => {
        const inserted = insertTaskMessage(runtime, actor, "progress", note, nowIso);
        runtime.db
          .prepare("UPDATE collab_tasks SET updated_at = ? WHERE id = ?")
          .run(nowIso, taskId);
        const event = appendEvent(runtime.db, {
          roomId: actor.room.id,
          type: "task.progress",
          actorAgentId: actor.agent.id,
          visibility: "room",
          taskId,
          messageId: inserted.id,
          payload: {
            taskId: String(taskId),
            status: currentStatus,
            action,
            note,
            messageId: String(inserted.id),
            assigneeAgentId: String(actor.agent.id),
          },
          createdAt: nowIso,
        });
        return { inserted, event };
      });
      return {
        task: loadTaskView(runtime, taskId),
        message: buildMessageView({
          id: result.inserted.id,
          roomId: actor.room.id,
          fromAgentId: actor.agent.id,
          kind: "progress",
          body: result.inserted.body,
          cursor: result.event.cursor,
          createdAt: asIsoDateTime(nowIso),
        }),
      };
    }
    case "complete": {
      if (currentStatus !== "in_progress") {
        throw invalidTransition(taskId, currentStatus, action);
      }
      const handoff = findLatestHandoff(runtime, taskId, actor.agent.id);
      if (handoff === undefined) {
        throw new DomainError("INVALID_STATE", "Conclusao exige handoff do agente atribuido.", {
          hint: "Envie collab_submit_handoff com objetivo, arquivos e resultados de teste antes de concluir.",
          context: { taskId },
        });
      }
      const sufficiency = evaluateHandoffSufficiency(handoff);
      if (!sufficiency.sufficient) {
        throw new DomainError(
          "VALIDATION_FAILED",
          "Handoff insuficiente para concluir a tarefa.",
          {
            hint: `Complete o handoff antes de concluir: ${sufficiency.missing.join("; ")}.`,
            context: { taskId, handoffId: handoff.id, missing: [...sufficiency.missing] },
          },
        );
      }

      runtime.db.transaction(() => {
        runtime.db
          .prepare(
            `UPDATE collab_tasks
             SET status = 'completed', completed_at = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(nowIso, nowIso, taskId);
        appendEvent(runtime.db, {
          roomId: actor.room.id,
          type: "task.completed",
          actorAgentId: actor.agent.id,
          visibility: "room",
          taskId,
          handoffId: handoff.id,
          payload: {
            taskId: String(taskId),
            status: "completed",
            action,
            handoffId: handoff.id,
            completedByAgentId: String(actor.agent.id),
            tests: handoff.tests.map((test) => ({
              name: test.name,
              passed: test.passed,
            })),
          },
          createdAt: nowIso,
        });
      });
      return { task: loadTaskView(runtime, taskId), handoff };
    }
    default:
      throw invalidTransition(taskId, currentStatus, action);
  }

  return { task: loadTaskView(runtime, taskId) };
}

export function listTasks(
  runtime: CollaborationRuntime,
  actor: AuthenticatedActor,
  options: ListTasksOptions = {},
): readonly TaskView[] {
  const limit = normalizeLimit(options.limit, 100, 200);
  const clauses = ["room_id = ?"];
  const params: (string | number)[] = [actor.room.id];

  if (options.status !== undefined) {
    clauses.push("status = ?");
    params.push(normalizeTaskStatus(options.status));
  }
  if (options.assigneeAgentId !== undefined) {
    const assignee = normalizeText(options.assigneeAgentId, "assigneeAgentId", 1, 100);
    clauses.push("assignee_agent_id = ?");
    params.push(assignee);
  }
  params.push(limit);

  const rows = runtime.db
    .prepare(
      `SELECT t.*,
              (SELECT COUNT(*) FROM collab_handoffs h WHERE h.task_id = t.id) AS handoff_count,
              (SELECT h.id FROM collab_handoffs h
                 WHERE h.task_id = t.id
                 ORDER BY h.created_at DESC, h.rowid DESC LIMIT 1) AS latest_handoff_id
       FROM collab_tasks t
       WHERE ${clauses.map((clause) => `t.${clause}`).join(" AND ")}
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT ?`,
    )
    .all(...params);

  return rows.map((row) =>
    toTaskView(row, loadDependencies(runtime, asTaskId(fieldString(row, "id")))),
  );
}
