import {
  asAgentId,
  asIsoDateTime,
  asRoomId,
  asTaskId,
  DomainError,
  type AgentId,
  type FileChangeKind,
  type TaskId,
} from "../contracts/index.js";
import type { SqlRow } from "../persistence/index.js";
import type { CollaborationRuntime } from "./context.js";
import { appendEvent } from "./events.js";
import { newCollaborationId } from "./ids.js";
import {
  fieldOptionalString,
  fieldString,
  parseJsonArrayColumn,
  parseStringArrayColumn,
  stringArrayToJson,
  toJsonText,
} from "./rows.js";
import { hasRole } from "./membership.js";
import type {
  AuthenticatedActor,
  HandoffChange,
  HandoffDecision,
  HandoffReviewStatus,
  HandoffSufficiency,
  HandoffTest,
  HandoffView,
  ListHandoffsOptions,
  RetainedLockView,
  ReviewHandoffInput,
  SubmitHandoffInput,
} from "./types.js";
import {
  normalizeDeclaredPath,
  normalizeFileChangeKind,
  normalizeLimit,
  normalizeOptionalText,
  normalizeStringList,
  normalizeText,
  validationError,
} from "./validation.js";

const ALLOWED_SUBMIT_STATUSES = new Set(["accepted", "in_progress", "blocked"]);

function parseChanges(raw: string): readonly HandoffChange[] {
  const values = parseJsonArrayColumn(raw, "changes");
  const changes: HandoffChange[] = [];
  for (const value of values) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("changes invalido no banco.");
    }
    const record = value as Record<string, unknown>;
    if (typeof record["path"] !== "string" || typeof record["kind"] !== "string") {
      throw new Error("changes invalido no banco.");
    }
    const kind = record["kind"] as FileChangeKind;
    if (kind !== "created" && kind !== "modified" && kind !== "deleted") {
      throw new Error("changes invalido no banco.");
    }
    changes.push({ path: record["path"], kind });
  }
  return changes;
}

function parseTests(raw: string): readonly HandoffTest[] {
  const values = parseJsonArrayColumn(raw, "tests");
  const tests: HandoffTest[] = [];
  for (const value of values) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("tests invalido no banco.");
    }
    const record = value as Record<string, unknown>;
    if (typeof record["name"] !== "string" || typeof record["passed"] !== "boolean") {
      throw new Error("tests invalido no banco.");
    }
    tests.push({ name: record["name"], passed: record["passed"] });
  }
  return tests;
}

function parseRetainedLocks(raw: string): readonly RetainedLockView[] {
  const values = parseJsonArrayColumn(raw, "retained_locks");
  const locks: RetainedLockView[] = [];
  for (const value of values) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("retained_locks invalido no banco.");
    }
    const record = value as Record<string, unknown>;
    if (typeof record["lockId"] !== "string" || typeof record["reason"] !== "string") {
      throw new Error("retained_locks invalido no banco.");
    }
    locks.push({ lockId: record["lockId"], reason: record["reason"] });
  }
  return locks;
}

function toHandoffView(row: SqlRow): HandoffView {
  return {
    id: fieldString(row, "id"),
    roomId: asRoomId(fieldString(row, "room_id")),
    taskId: asTaskId(fieldString(row, "task_id")),
    fromAgentId: asAgentId(fieldString(row, "from_agent_id")),
    objective: fieldString(row, "objective"),
    changes: parseChanges(fieldString(row, "changes")),
    releasedLocks: parseStringArrayColumn(fieldString(row, "released_locks"), "released_locks"),
    retainedLocks: parseRetainedLocks(fieldString(row, "retained_locks")),
    tests: parseTests(fieldString(row, "tests")),
    decisions: parseStringArrayColumn(fieldString(row, "decisions"), "decisions"),
    knownIssues: parseStringArrayColumn(fieldString(row, "known_issues"), "known_issues"),
    reusable: parseStringArrayColumn(fieldString(row, "reusable"), "reusable"),
    pending: parseStringArrayColumn(fieldString(row, "pending"), "pending"),
    nextStep: fieldOptionalString(row, "next_step"),
    reviewStatus: fieldString(row, "review_status") as HandoffReviewStatus,
    reviewedByAgentId: fieldOptionalString(row, "reviewed_by_agent_id") as
      | AgentId
      | undefined,
    reviewNotes: fieldOptionalString(row, "review_notes"),
    reviewedAt: fieldOptionalString(row, "reviewed_at") as
      | HandoffView["reviewedAt"]
      | undefined,
    createdAt: asIsoDateTime(fieldString(row, "created_at")),
  };
}

/**
 * Suficiencia minima para CONCLUIR tarefa: objetivo real (>= 10 caracteres) e
 * ao menos um resultado de teste. Enviar um handoff curto e permitido, mas ele
 * nao basta para `complete`; isso impede concluir apenas com "done".
 */
export function evaluateHandoffSufficiency(handoff: HandoffView): HandoffSufficiency {
  const missing: string[] = [];
  if (handoff.objective.trim().length < 10) {
    missing.push("objective com pelo menos 10 caracteres descrevendo o que foi feito");
  }
  if (handoff.tests.length === 0) {
    missing.push("pelo menos um resultado em tests[]");
  } else if (handoff.tests.some((test) => test.name.trim().length < 2)) {
    missing.push("nome de teste valido em tests[]");
  }
  return { sufficient: missing.length === 0, missing };
}

export function submitHandoff(
  runtime: CollaborationRuntime,
  actor: AuthenticatedActor,
  input: SubmitHandoffInput,
): HandoffView {
  const taskId = asTaskId(normalizeText(input.taskId, "taskId", 1, 100));
  const task = runtime.db
    .prepare("SELECT * FROM collab_tasks WHERE id = ? AND room_id = ?")
    .get(taskId, actor.room.id);
  if (task === undefined) {
    throw new DomainError("NOT_FOUND", "Tarefa nao encontrada nesta sala.", {
      hint: "Use um taskId retornado por collab_propose_task.",
      context: { taskId },
    });
  }

  const assignee = fieldOptionalString(task, "assignee_agent_id") as AgentId | undefined;
  if (assignee === undefined) {
    throw new DomainError("INVALID_STATE", "Tarefa sem agente atribuido.", {
      hint: "Peca ao coordinator para atribuir a tarefa antes de enviar o handoff.",
      context: { taskId },
    });
  }
  if (assignee !== actor.agent.id) {
    throw new DomainError("FORBIDDEN", "Somente o agente atribuido pode enviar o handoff desta tarefa.", {
      hint: "O handoff deve ter autoria do responsavel atual pela tarefa.",
      context: { taskId },
    });
  }

  const status = fieldString(task, "status");
  if (!ALLOWED_SUBMIT_STATUSES.has(status)) {
    throw new DomainError("INVALID_STATE", `Nao e possivel enviar handoff com a tarefa em "${status}".`, {
      hint: "Aceite/continue a tarefa (accepted/in_progress/blocked) antes do handoff.",
      context: { taskId, status },
    });
  }

  const objective = normalizeText(input.objective, "objective", 1, 4000);
  const changesInput = input.changes ?? [];
  if (changesInput.length > 100) {
    throw validationError(
      'Campo "changes" excede 100 itens.',
      "Declare apenas os arquivos relevantes para o handoff.",
      "changes",
    );
  }
  const changes: HandoffChange[] = changesInput.map((change) => ({
    path: normalizeDeclaredPath(change.path),
    kind: normalizeFileChangeKind(change.kind),
  }));

  const testsInput = input.tests ?? [];
  if (testsInput.length > 100) {
    throw validationError(
      'Campo "tests" excede 100 itens.',
      "Resuma os resultados de teste mais relevantes.",
      "tests",
    );
  }
  const tests: HandoffTest[] = testsInput.map((test) => ({
    name: normalizeText(test.name, "tests[].name", 1, 200),
    passed: test.passed === true,
  }));

  const decisions = normalizeStringList(input.decisions, "decisions", 100, 2000);
  const knownIssues = normalizeStringList(input.knownIssues, "knownIssues", 100, 2000);
  const reusable = normalizeStringList(input.reusable, "reusable", 100, 2000);
  const pending = normalizeStringList(input.pending, "pending", 100, 2000);
  const nextStep = normalizeOptionalText(input.nextStep, "nextStep", 2000);

  const now = runtime.now();
  const nowIso = now.toISOString();
  const handoffId = newCollaborationId("handoff");
  const reviewStatus: HandoffReviewStatus =
    input.requestReview === true ? "pending" : "not_requested";

  runtime.db.transaction(() => {
    runtime.db
      .prepare(
        `INSERT INTO collab_handoffs (
           id, room_id, task_id, from_agent_id, objective, changes,
           released_locks, retained_locks, tests, decisions, known_issues,
           reusable, pending, next_step, review_status, reviewed_by_agent_id,
           review_notes, reviewed_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
      )
      .run(
        handoffId,
        actor.room.id,
        taskId,
        actor.agent.id,
        objective,
        toJsonText(changes),
        toJsonText(tests),
        stringArrayToJson(decisions),
        stringArrayToJson(knownIssues),
        stringArrayToJson(reusable),
        stringArrayToJson(pending),
        nextStep ?? null,
        reviewStatus,
        nowIso,
      );

    runtime.db
      .prepare("UPDATE collab_tasks SET updated_at = ? WHERE id = ?")
      .run(nowIso, taskId);

    appendEvent(runtime.db, {
      roomId: actor.room.id,
      type: "handoff.submitted",
      actorAgentId: actor.agent.id,
      visibility: "room",
      taskId,
      handoffId,
      payload: {
        handoffId,
        taskId: String(taskId),
        fromAgentId: String(actor.agent.id),
        objective,
        changes: changes.map((change) => ({ path: change.path, kind: change.kind })),
        tests: tests.map((test) => ({ name: test.name, passed: test.passed })),
        reviewStatus,
      },
      createdAt: nowIso,
    });
  });

  const row = runtime.db
    .prepare("SELECT * FROM collab_handoffs WHERE id = ?")
    .get(handoffId);
  if (row === undefined) {
    throw new DomainError("INTERNAL", "Handoff nao foi persistido.", {
      hint: "Verifique a integridade do SQLite e tente novamente.",
    });
  }
  return toHandoffView(row);
}

export function reviewHandoff(
  runtime: CollaborationRuntime,
  actor: AuthenticatedActor,
  input: ReviewHandoffInput,
): HandoffView {
  const handoffId = normalizeText(input.handoffId, "handoffId", 1, 100);
  const decision: HandoffDecision = input.decision;
  if (decision !== "approved" && decision !== "changes_requested") {
    throw validationError(
      `Decisao de revisao desconhecida: "${String(decision)}".`,
      "Use approved ou changes_requested.",
      "decision",
    );
  }

  const row = runtime.db
    .prepare("SELECT * FROM collab_handoffs WHERE id = ? AND room_id = ?")
    .get(handoffId, actor.room.id);
  if (row === undefined) {
    throw new DomainError("NOT_FOUND", "Handoff nao encontrado nesta sala.", {
      hint: "Use um handoffId retornado por collab_submit_handoff ou collab_list_handoffs.",
      context: { handoffId },
    });
  }

  const authorId = asAgentId(fieldString(row, "from_agent_id"));
  if (authorId === actor.agent.id) {
    throw new DomainError("FORBIDDEN", "O autor nao pode revisar o proprio handoff.", {
      hint: "Peca a um reviewer ou ao coordinator da sala para revisar.",
      context: { handoffId },
    });
  }
  if (!actor.isCoordinator && !hasRole(actor, "reviewer")) {
    throw new DomainError("FORBIDDEN", "Somente reviewer ou coordinator pode revisar o handoff.", {
      hint: "Peca ao coordinator para conceder reviewer no proximo convite ou revisar diretamente.",
      context: { handoffId },
    });
  }

  const reviewStatus = fieldString(row, "review_status") as HandoffReviewStatus;
  if (reviewStatus !== "pending") {
    throw new DomainError("INVALID_STATE", "Handoff nao esta aguardando revisao.", {
      hint:
        reviewStatus === "not_requested"
          ? "O autor deve enviar o handoff com requestReview=true."
          : "Este handoff ja foi revisado; envie um novo handoff se necessario.",
      context: { handoffId, reviewStatus },
    });
  }

  const notes =
    decision === "changes_requested"
      ? normalizeText(input.notes ?? "", "notes", 3, 4000)
      : normalizeOptionalText(input.notes, "notes", 4000);

  const now = runtime.now();
  const nowIso = now.toISOString();
  const taskId = asTaskId(fieldString(row, "task_id"));

  runtime.db.transaction(() => {
    const updated = runtime.db
      .prepare(
        `UPDATE collab_handoffs
         SET review_status = ?, reviewed_by_agent_id = ?, review_notes = ?, reviewed_at = ?
         WHERE id = ? AND review_status = 'pending'`,
      )
      .run(decision, actor.agent.id, notes ?? null, nowIso, handoffId);
    if (updated.changes !== 1) {
      throw new DomainError("CONFLICT", "Handoff revisado por outra chamada concorrente.", {
        hint: "Consulte collab_list_handoffs para ver a revisao registrada.",
        context: { handoffId },
      });
    }

    appendEvent(runtime.db, {
      roomId: actor.room.id,
      type: "handoff.reviewed",
      actorAgentId: actor.agent.id,
      visibility: "room",
      taskId,
      handoffId,
      payload: {
        handoffId,
        taskId: String(taskId),
        decision,
        ...(notes === undefined ? {} : { notes }),
        reviewedByAgentId: String(actor.agent.id),
      },
      createdAt: nowIso,
    });
  });

  const updatedRow = runtime.db
    .prepare("SELECT * FROM collab_handoffs WHERE id = ?")
    .get(handoffId);
  if (updatedRow === undefined) {
    throw new DomainError("INTERNAL", "Handoff nao encontrado apos revisao.", {
      hint: "Verifique a integridade do SQLite e tente novamente.",
    });
  }
  return toHandoffView(updatedRow);
}

export function listHandoffs(
  runtime: CollaborationRuntime,
  actor: AuthenticatedActor,
  options: ListHandoffsOptions = {},
): readonly HandoffView[] {
  const limit = normalizeLimit(options.limit, 100, 200);
  const params: (string | number)[] = [actor.room.id];
  let taskClause = "";
  if (options.taskId !== undefined) {
    const taskId = normalizeText(options.taskId, "taskId", 1, 100);
    const task = runtime.db
      .prepare("SELECT id FROM collab_tasks WHERE id = ? AND room_id = ?")
      .get(taskId, actor.room.id);
    if (task === undefined) {
      throw new DomainError("NOT_FOUND", "Tarefa nao encontrada nesta sala.", {
        hint: "Use um taskId retornado por collab_list_tasks.",
        context: { taskId },
      });
    }
    taskClause = " AND task_id = ?";
    params.push(taskId);
  }
  params.push(limit);

  const rows = runtime.db
    .prepare(
      `SELECT * FROM collab_handoffs
       WHERE room_id = ?${taskClause}
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(...params);
  return rows.map(toHandoffView);
}

/** Usado pela conclusao de tarefa; retorna o handoff mais recente do autor. */
export function findLatestHandoff(
  runtime: CollaborationRuntime,
  taskId: TaskId,
  fromAgentId: AgentId,
): HandoffView | undefined {
  const row = runtime.db
    .prepare(
      `SELECT * FROM collab_handoffs
       WHERE task_id = ? AND from_agent_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
    )
    .get(taskId, fromAgentId);
  return row === undefined ? undefined : toHandoffView(row);
}
