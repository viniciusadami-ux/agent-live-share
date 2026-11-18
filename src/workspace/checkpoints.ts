import {
  asCheckpointId,
  asIsoDateTime,
  asRoomId,
  DomainError,
  type AgentId,
  type WorkspaceId,
} from "../contracts/index.js";
import { appendEvent, type AuthenticatedActor } from "../collaboration/index.js";
import type { SqlRow } from "../persistence/index.js";
import type { WorkspaceRuntime } from "./runtime.js";
import { newWorkspaceObjectId } from "./catalog.js";
import { requireAuthorizedWorkspace } from "./files.js";
import {
  fieldNumber,
  fieldOptionalString,
  fieldString,
} from "./rows.js";
import type { CheckpointStatus, CheckpointView } from "./types.js";

/**
 * Checkpoints GLOBAIS por workspace.
 *
 * - Um checkpoint ABERTO pausa TODAS as mutacoes (patch/create/restore) no
 *   workspace, independentemente da sala. `assertNotPaused` e chamado por toda
 *   mutacao. Lock acquire/renew/release continuam disponiveis (sao coordenacao,
 *   nao mutacao de arquivo), mas ficam inuteis durante a pausa.
 * - Somente o coordinator ATUAL de uma sala autorizada pode iniciar/encerrar.
 * - Estado estavel simples: nenhum lock ATIVO (held, nao expirado) no workspace
 *   no momento do inicio. Expiracao lazy e aplicada antes da contagem.
 * - REGRA ANTI-DEADLOCK: o checkpoint pode ser encerrado por QUALQUER
 *   coordinator ATUAL de sala que aponte para o mesmo workspace, nao apenas
 *   pelo criador. A criacao (`created_by_agent_id`) e o encerramento
 *   (`sealed_by_agent_id`) ficam registrados separadamente; o evento
 *   `checkpoint.sealed` e gravado na sala de origem com o autor real.
 *   Assim, transferir a coordenacao nunca deixa o workspace pausado para
 *   sempre.
 * - Nenhum Git/shell e executado; note/testResults sao apenas metadados.
 */

const CREATE_DENIED_HINT =
  "Somente o coordinator da sala pode iniciar um checkpoint. Libere todos os locks antes de iniciar.";

function requireCoordinatorForCheckpoint(
  runtime: WorkspaceRuntime,
  actor: AuthenticatedActor,
): void {
  // A sala e a fonte de verdade: relemos o coordinator atual em vez de confiar
  // apenas no snapshot do ator. Isso fecha a janela de uma transferencia feita
  // depois da autenticacao (evita que o antigo coordinator encerre por engano).
  const row = runtime.db
    .prepare("SELECT coordinator_agent_id FROM collab_rooms WHERE id = ?")
    .get(actor.room.id) as SqlRow | undefined;
  const currentCoordinator = row === undefined ? undefined : fieldString(row, "coordinator_agent_id");
  if (currentCoordinator !== String(actor.agent.id)) {
    throw new DomainError("FORBIDDEN", "Somente o coordinator ATUAL da sala pode gerenciar checkpoints.", {
      hint: "Consulte collab_room_state e peca ao coordinator atual para iniciar/encerrar o checkpoint.",
    });
  }
}

/** Conta locks ativos no workspace. Defensivo: funciona mesmo sem migration 20. */
export function countActiveLocks(
  runtime: WorkspaceRuntime,
  workspaceId: WorkspaceId,
): number {
  const tableExists = runtime.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'file_locks'")
    .get();
  if (tableExists === undefined) return 0;
  const nowIso = runtime.now().toISOString();
  runtime.db
    .prepare("UPDATE file_locks SET status = 'expired' WHERE status = 'held' AND expires_at <= ?")
    .run(nowIso);
  const row = runtime.db
    .prepare(
      "SELECT COUNT(*) AS total FROM file_locks WHERE workspace_id = ? AND status = 'held'",
    )
    .get(workspaceId) as SqlRow | undefined;
  return row === undefined ? 0 : fieldNumber(row, "total");
}

export function findOpenCheckpoint(
  runtime: WorkspaceRuntime,
  workspaceId: WorkspaceId,
): SqlRow | undefined {
  return runtime.db
    .prepare("SELECT * FROM ws_checkpoints WHERE workspace_id = ? AND status = 'open'")
    .get(workspaceId) as SqlRow | undefined;
}

/** Bloqueia mutacoes enquanto houver checkpoint aberto no workspace. */
export function assertNotPaused(runtime: WorkspaceRuntime, workspaceId: WorkspaceId): void {
  const open = findOpenCheckpoint(runtime, workspaceId);
  if (open !== undefined) {
    throw new DomainError(
      "CHECKPOINT_IN_PROGRESS",
      "Checkpoint em andamento: novas gravacoes estao pausadas neste workspace.",
      {
        hint:
          "Aguarde o coordinator encerrar o checkpoint com collab_checkpoint_end antes de aplicar patches/criar/restaurar arquivos.",
        context: { checkpointId: fieldString(open, "id") },
      },
    );
  }
}

function toCheckpointView(row: SqlRow): CheckpointView {
  const status = fieldString(row, "status") as CheckpointStatus;
  const testResultsRaw = fieldOptionalString(row, "test_results");
  let testResults: Readonly<Record<string, unknown>> | undefined;
  if (testResultsRaw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(testResultsRaw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        testResults = parsed as Readonly<Record<string, unknown>>;
      }
    } catch {
      // metadado opcional corrompido: ignorado sem expor conteudo
    }
  }
  return {
    id: String(asCheckpointId(fieldString(row, "id"))),
    workspaceId: fieldString(row, "workspace_id") as WorkspaceId,
    roomId: fieldString(row, "room_id") as CheckpointView["roomId"],
    status,
    createdByAgentId: fieldString(row, "created_by_agent_id") as AgentId,
    note: fieldOptionalString(row, "note"),
    testResults,
    createdAt: asIsoDateTime(fieldString(row, "created_at")),
    sealedAt:
      fieldOptionalString(row, "sealed_at") === undefined
        ? undefined
        : asIsoDateTime(fieldString(row, "sealed_at")),
    sealedByAgentId:
      fieldOptionalString(row, "sealed_by_agent_id") === undefined
        ? undefined
        : (fieldString(row, "sealed_by_agent_id") as AgentId),
  };
}

const MAX_CHECKPOINT_NOTE_LENGTH = 4000;
const MAX_TEST_RESULTS_BYTES = 32_768;

function normalizeCheckpointNote(note: string | undefined): string | null {
  if (note === undefined) return null;
  const trimmed = note.trim();
  if (trimmed.length > MAX_CHECKPOINT_NOTE_LENGTH) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `note do checkpoint excede ${MAX_CHECKPOINT_NOTE_LENGTH} caracteres.`,
      { hint: "Resuma a nota do checkpoint e tente novamente." },
    );
  }
  return trimmed.length === 0 ? null : trimmed;
}

function serializeTestResults(value: Readonly<Record<string, unknown>> | undefined): string | null {
  if (value === undefined) return null;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    // cai no erro abaixo
  }
  if (serialized === undefined) {
    throw new DomainError("VALIDATION_FAILED", "testResults nao e serializavel.", {
      hint: "Envie um objeto JSON simples com resultados de teste.",
    });
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_TEST_RESULTS_BYTES) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `testResults excede ${MAX_TEST_RESULTS_BYTES} bytes.`,
      { hint: "Resuma os resultados de teste do checkpoint." },
    );
  }
  return serialized;
}

export interface BeginCheckpointInput {
  readonly note?: string;
  readonly testResults?: Readonly<Record<string, unknown>>;
}

export function beginCheckpoint(
  runtime: WorkspaceRuntime,
  actor: AuthenticatedActor,
  input: BeginCheckpointInput = {},
): CheckpointView {
  requireCoordinatorForCheckpoint(runtime, actor);
  const workspaceId = actor.room.workspaceId;

  // Autorizacao por workspace (fail-closed) tambem no servico, alem do withActor.
  requireAuthorizedWorkspace(runtime, actor);
  if (findOpenCheckpoint(runtime, workspaceId) !== undefined) {
    throw new DomainError(
      "ALREADY_EXISTS",
      "Ja existe um checkpoint aberto neste workspace.",
      {
        hint: "Encerre o checkpoint atual com collab_checkpoint_end antes de iniciar outro.",
      },
    );
  }
  const activeLocks = countActiveLocks(runtime, workspaceId);
  if (activeLocks > 0) {
    throw new DomainError(
      "INVALID_STATE",
      `Nao e possivel iniciar checkpoint: ${activeLocks} lock(s) ativo(s) no workspace.`,
      {
        hint: CREATE_DENIED_HINT,
      },
    );
  }

  const nowIso = runtime.now().toISOString();
  const id = newWorkspaceObjectId("ckpt");
  const note = normalizeCheckpointNote(input.note);
  const testResults = serializeTestResults(input.testResults);
  runtime.db.transaction(() => {
    runtime.db
      .prepare(
        `INSERT INTO ws_checkpoints (
           id, workspace_id, room_id, created_by_agent_id, status,
           note, test_results, created_at
         ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        actor.room.id,
        actor.agent.id,
        note,
        testResults,
        nowIso,
      );

    appendEvent(runtime.db, {
      roomId: actor.room.id,
      type: "checkpoint.opened",
      actorAgentId: actor.agent.id,
      visibility: "room",
      payload: {
        checkpointId: id,
        workspaceId: String(workspaceId),
        createdByAgentId: String(actor.agent.id),
        status: "open",
      },
      createdAt: nowIso,
    });
  });
  const row = runtime.db.prepare("SELECT * FROM ws_checkpoints WHERE id = ?").get(id);
  if (row === undefined) {
    throw new DomainError("INTERNAL", "Checkpoint nao foi persistido.", {
      hint: "Verifique a integridade do SQLite e tente novamente.",
    });
  }
  return toCheckpointView(row);
}

export interface EndCheckpointInput {
  readonly note?: string;
  readonly testResults?: Readonly<Record<string, unknown>>;
}

export function endCheckpoint(
  runtime: WorkspaceRuntime,
  actor: AuthenticatedActor,
  input: EndCheckpointInput = {},
): CheckpointView {
  requireCoordinatorForCheckpoint(runtime, actor);
  requireAuthorizedWorkspace(runtime, actor);
  const workspaceId = actor.room.workspaceId;
  const open = findOpenCheckpoint(runtime, workspaceId);
  if (open === undefined) {
    throw new DomainError("NOT_FOUND", "Nenhum checkpoint aberto neste workspace.", {
      hint: "Inicie um checkpoint com collab_checkpoint_begin antes de encerrar.",
    });
  }
  const nowIso = runtime.now().toISOString();
  const id = fieldString(open, "id");
  const checkpointRoomId = asRoomId(fieldString(open, "room_id"));
  const createdByAgentId = fieldString(open, "created_by_agent_id");
  const existingTestResults = fieldOptionalString(open, "test_results");
  const testResults =
    input.testResults === undefined
      ? existingTestResults ?? null
      : serializeTestResults(input.testResults);
  const note =
    normalizeCheckpointNote(input.note) ?? fieldOptionalString(open, "note") ?? null;

  runtime.db.transaction(() => {
    const updated = runtime.db
      .prepare(
        `UPDATE ws_checkpoints
         SET status = 'sealed', sealed_at = ?, sealed_by_agent_id = ?, note = ?, test_results = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(nowIso, actor.agent.id, note, testResults, id);
    if (updated.changes !== 1) {
      throw new DomainError("CONFLICT", "Checkpoint mudou de estado durante o encerramento.", {
        hint: "Consulte collab_checkpoint_status e tente novamente.",
      });
    }

    // Evento na sala de ORIGEM do checkpoint, com o autor real do encerramento.
    // Cobre o caso de coordenacao transferida: quem encerra pode ser outro
    // coordinator atual, mas a autoria fica auditavel.
    appendEvent(runtime.db, {
      roomId: checkpointRoomId,
      type: "checkpoint.sealed",
      actorAgentId: actor.agent.id,
      visibility: "room",
      payload: {
        checkpointId: id,
        workspaceId: String(workspaceId),
        createdByAgentId,
        sealedByAgentId: String(actor.agent.id),
        status: "sealed",
      },
      createdAt: nowIso,
    });
  });
  const row = runtime.db.prepare("SELECT * FROM ws_checkpoints WHERE id = ?").get(id);
  if (row === undefined) {
    throw new DomainError("INTERNAL", "Checkpoint nao encontrado apos encerramento.", {
      hint: "Verifique a integridade do SQLite.",
    });
  }
  return toCheckpointView(row);
}

export interface CheckpointStatusResult {
  readonly paused: boolean;
  readonly checkpoint?: CheckpointView;
  readonly activeLocks: number;
}

export function checkpointStatus(
  runtime: WorkspaceRuntime,
  actor: AuthenticatedActor,
): CheckpointStatusResult {
  requireAuthorizedWorkspace(runtime, actor);
  const workspaceId = actor.room.workspaceId;
  const open = findOpenCheckpoint(runtime, workspaceId);
  if (open !== undefined) {
    return { paused: true, checkpoint: toCheckpointView(open), activeLocks: countActiveLocks(runtime, workspaceId) };
  }
  const last = runtime.db
    .prepare(
      `SELECT * FROM ws_checkpoints
       WHERE workspace_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(workspaceId) as SqlRow | undefined;
  return {
    paused: false,
    ...(last === undefined ? {} : { checkpoint: toCheckpointView(last) }),
    activeLocks: countActiveLocks(runtime, workspaceId),
  };
}
