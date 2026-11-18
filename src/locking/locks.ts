import {
  asLockId,
  asIsoDateTime,
  asNormalizedPath,
  asTaskId,
  DomainError,
  type AgentId,
  type NormalizedPath,
  type TaskId,
  type WorkspaceId,
} from "../contracts/index.js";
import type { AuthenticatedActor } from "../collaboration/index.js";
import type { SqlRow } from "../persistence/index.js";
import type { WorkspaceRuntime } from "../workspace/runtime.js";
import { newWorkspaceObjectId } from "../workspace/catalog.js";
import { requireAuthorizedWorkspace } from "../workspace/files.js";
import {
  normalizeRelativePath,
  resolveWorkspacePath,
} from "../workspace/paths.js";
import {
  fieldOptionalString,
  fieldString,
} from "../workspace/rows.js";
import type { LockAcquireResult, LockView } from "../workspace/types.js";

/**
 * Locks EXCLUSIVOS por (workspace_id, path_key) — GLOBAL no workspace.
 *
 * - A exclusividade e garantida pelo indice UNIQUE PARCIAL sobre status='held'
 *   (migration 020) + transacao SQLite.better-sqlite3 e sincrono: nao ha
 *   intercalacao entre a checagem e o INSERT dentro do processo.
 * - Expiracao LAZY: antes de cada operacao marcamos como 'expired' os locks
 *   'held' com expires_at <= agora. Isso permite recuperar locks abandonados
 *   sem daemon e mantem o indice UNIQUE livre para nova aquisicao.
 * - NEGOCIACAO: conflito devolve erro acionavel com displayName/intencao/
 *   expiracao do dono e orienta `collab_send_message` + trabalho em outro
 *   arquivo. Como o lock e global por workspace, a negociacao entre SALAS
 *   DIFERENTES depende de canal externo (limitacao documentada): nunca
 *   enfraquecemos a exclusividade para contorna-la.
 * - Somente o DONO autenticado (mesma session_id + agent_id) renova/libera.
 *   Coordinator NAO rouba lock.
 * - Nenhum root absoluto/token e exposto.
 */

function nowIsoOf(runtime: WorkspaceRuntime): string {
  return runtime.now().toISOString();
}

export function lazyExpireLocks(runtime: WorkspaceRuntime): void {
  runtime.db
    .prepare("UPDATE file_locks SET status = 'expired' WHERE status = 'held' AND expires_at <= ?")
    .run(nowIsoOf(runtime));
}

function displayNameOf(runtime: WorkspaceRuntime, agentId: string): string {
  const row = runtime.db
    .prepare("SELECT display_name FROM collab_agents WHERE id = ?")
    .get(agentId) as SqlRow | undefined;
  return row === undefined ? "(agente desconhecido)" : fieldString(row, "display_name");
}

function toLockView(runtime: WorkspaceRuntime, row: SqlRow): LockView {
  const agentId = fieldString(row, "agent_id");
  return {
    id: asLockId(fieldString(row, "id")),
    path: asNormalizedPath(fieldString(row, "path")),
    workspaceId: fieldString(row, "workspace_id") as WorkspaceId,
    roomId: fieldString(row, "room_id") as LockView["roomId"],
    agentId: agentId as AgentId,
    agentDisplayName: displayNameOf(runtime, agentId),
    taskId:
      fieldOptionalString(row, "task_id") === undefined
        ? undefined
        : (fieldString(row, "task_id") as TaskId),
    intent: fieldString(row, "intent"),
    status: fieldString(row, "status") as LockView["status"],
    acquiredAt: asIsoDateTime(fieldString(row, "acquired_at")),
    lastHeartbeatAt: asIsoDateTime(fieldString(row, "last_heartbeat_at")),
    expiresAt: asIsoDateTime(fieldString(row, "expires_at")),
    releasedAt:
      fieldOptionalString(row, "released_at") === undefined
        ? undefined
        : asIsoDateTime(fieldString(row, "released_at")),
  };
}

function loadRow(runtime: WorkspaceRuntime, lockId: string): SqlRow | undefined {
  return runtime.db.prepare("SELECT * FROM file_locks WHERE id = ?").get(lockId) as
    | SqlRow
    | undefined;
}

function loadHeld(runtime: WorkspaceRuntime, workspaceId: WorkspaceId, key: string): SqlRow | undefined {
  return runtime.db
    .prepare(
      `SELECT * FROM file_locks
       WHERE workspace_id = ? AND path_key = ? AND status = 'held' LIMIT 1`,
    )
    .get(workspaceId, key) as SqlRow | undefined;
}

function conflictError(runtime: WorkspaceRuntime, row: SqlRow, path: NormalizedPath): DomainError {
  const owner = displayNameOf(runtime, fieldString(row, "agent_id"));
  const intent = fieldString(row, "intent");
  const expiresAt = fieldString(row, "expires_at");
  return new DomainError(
    "LOCK_ALREADY_HELD",
    `O arquivo "${String(path)}" ja esta reservado por ${owner}.`,
    {
      hint:
        `Use collab_send_message para negociar a liberacao com ${owner} ` +
        `(intencao: "${intent}"; expira em ${expiresAt}) e trabalhe em outro arquivo enquanto isso. ` +
        "Quando o lock for liberado ou expirar, adquira-o novamente e RELEIA o arquivo antes de patchar.",
      context: { ownerDisplayName: owner, intent, expiresAt, path: String(path) },
    },
  );
}

/** Valida taskId (opcional) contra a SALA autenticada, sem aceitar IDs soltos. */
function validateTask(runtime: WorkspaceRuntime, actor: AuthenticatedActor, taskId?: string): TaskId | undefined {
  if (taskId === undefined) return undefined;
  const trimmed = taskId.trim();
  if (trimmed.length === 0 || trimmed.length > 100) {
    throw new DomainError("VALIDATION_FAILED", "taskId invalido.", {
      hint: "Use o id retornado por collab_propose_task (1 a 100 caracteres).",
    });
  }
  const row = runtime.db
    .prepare("SELECT id FROM collab_tasks WHERE id = ? AND room_id = ?")
    .get(trimmed, actor.room.id) as SqlRow | undefined;
  if (row === undefined) {
    throw new DomainError("NOT_FOUND", "Tarefa nao encontrada nesta sala.", {
      hint: "O taskId precisa pertencer a sala autenticada; use collab_list_tasks para obter ids validos.",
      context: { taskId: trimmed },
    });
  }
  return asTaskId(trimmed);
}

export interface AcquireLockInput {
  readonly path: string;
  readonly intent: string;
  readonly taskId?: string;
}

export function acquireLock(
  runtime: WorkspaceRuntime,
  actor: AuthenticatedActor,
  input: AcquireLockInput,
): LockAcquireResult {
  requireAuthorizedWorkspace(runtime, actor);
  const normalized = normalizeRelativePath(input.path);
  // Adquire cedo: caminho precisa estar contido no root real e nao atravessar
  // symlink/junction. Arquivo novo e permitido, mas o diretorio pai deve existir.
  const resolved = resolveWorkspacePath({
    catalog: runtime.catalog,
    workspaceId: actor.room.workspaceId,
    normalized,
    allowMissingFinal: true,
  });
  if (resolved.isDirectory) {
    throw new DomainError("VALIDATION_FAILED", "Nao e possivel reservar um diretorio.", {
      hint: "Locks sao por ARQUIVO; informe o caminho relativo de um arquivo (existente ou novo).",
    });
  }
  const intent = input.intent.trim();
  if (intent.length === 0 || intent.length > runtime.limits.maxIntentLength) {
    throw new DomainError("VALIDATION_FAILED", "intent invalida.", {
      hint: `Descreva a intencao em 1 a ${runtime.limits.maxIntentLength} caracteres.`,
    });
  }
  const taskId = validateTask(runtime, actor, input.taskId);
  const nowIso = nowIsoOf(runtime);
  const expiresAt = new Date(runtime.now().getTime() + runtime.limits.lockTtlMs).toISOString();
  const workspaceId = actor.room.workspaceId;
  const id = newWorkspaceObjectId("lock");

  const run = (): { row: SqlRow; reacquired: boolean } =>
    runtime.db.transaction<{ row: SqlRow; reacquired: boolean }>(() => {
      lazyExpireLocks(runtime);
      const existing = loadHeld(runtime, workspaceId, normalized.key);
      if (existing !== undefined) {
        const sameOwner =
          fieldString(existing, "agent_id") === String(actor.agent.id) &&
          fieldString(existing, "session_id") === String(actor.session.id);
        if (sameOwner) {
          // Reaquisicao pelo mesmo dono = renovacao segura (nao cria 2o lock).
          runtime.db
            .prepare(
              `UPDATE file_locks
               SET last_heartbeat_at = ?, expires_at = ?, intent = ?, task_id = ?
               WHERE id = ? AND status = 'held'`,
            )
            .run(nowIso, expiresAt, intent, taskId ?? null, fieldString(existing, "id"));
          const refreshed = loadRow(runtime, fieldString(existing, "id"));
          if (refreshed === undefined) {
            throw new DomainError("INTERNAL", "Falha ao renovar lock existente.", {
              hint: "Tente novamente; se persistir, libere e adquira outro lock.",
            });
          }
          return { row: refreshed, reacquired: true };
        }
        throw conflictError(runtime, existing, normalized.display);
      }

      runtime.db
        .prepare(
          `INSERT INTO file_locks (
             id, workspace_id, path, path_key, room_id, agent_id, session_id,
             task_id, intent, status, acquired_at, last_heartbeat_at, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, ?, ?)`,
        )
        .run(
          id,
          workspaceId,
          normalized.display,
          normalized.key,
          actor.room.id,
          actor.agent.id,
          actor.session.id,
          taskId ?? null,
          intent,
          nowIso,
          nowIso,
          expiresAt,
        );
      const created = loadRow(runtime, id);
      if (created === undefined) {
        throw new DomainError("INTERNAL", "Lock nao foi persistido.", {
          hint: "Verifique a integridade do SQLite e tente novamente.",
        });
      }
      return { row: created, reacquired: false };
    });

  let result: { row: SqlRow; reacquired: boolean };
  try {
    result = run();
  } catch (error) {
    // Backstop: UNIQUE parcial (outro processo no mesmo arquivo SQLite).
    if (error instanceof DomainError) throw error;
    const held = loadHeld(runtime, workspaceId, normalized.key);
    if (held !== undefined) throw conflictError(runtime, held, normalized.display);
    throw new DomainError("INTERNAL", "Falha atomica ao adquirir lock.", {
      hint: "Verifique a integridade do SQLite e tente novamente.",
      cause: error,
    });
  }
  return { lock: toLockView(runtime, result.row), reacquired: result.reacquired };
}

function assertOwned(actor: AuthenticatedActor, row: SqlRow): void {
  if (
    fieldString(row, "agent_id") !== String(actor.agent.id) ||
    fieldString(row, "session_id") !== String(actor.session.id)
  ) {
    throw new DomainError("FORBIDDEN", "Este lock pertence a outro agente/sessao.", {
      hint: "Somente o dono autenticado pode renovar/liberar; coordinator nao rouba lock. Negocie via collab_send_message.",
    });
  }
}

export interface RenewLockInput {
  readonly lockId: string;
}

export function renewLock(
  runtime: WorkspaceRuntime,
  actor: AuthenticatedActor,
  input: RenewLockInput,
): LockView {
  requireAuthorizedWorkspace(runtime, actor);
  const nowIso = nowIsoOf(runtime);
  const expiresAt = new Date(runtime.now().getTime() + runtime.limits.lockTtlMs).toISOString();
  return runtime.db.transaction<LockView>(() => {
    lazyExpireLocks(runtime);
    const row = loadRow(runtime, input.lockId.trim());
    if (row === undefined) {
      throw new DomainError("LOCK_NOT_HELD", "Lock nao encontrado.", {
        hint: "Adquira um lock com collab_lock_acquire antes de renovar.",
      });
    }
    assertOwned(actor, row);
    const status = fieldString(row, "status");
    if (status === "expired") {
      throw new DomainError("LOCK_EXPIRED", "Lock expirou; nao pode ser renovado.", {
        hint: "Adquira um novo lock com collab_lock_acquire e releia o arquivo.",
      });
    }
    if (status !== "held") {
      throw new DomainError("LOCK_NOT_HELD", "Lock nao esta ativo.", {
        hint: "Adquira um novo lock com collab_lock_acquire.",
      });
    }
    runtime.db
      .prepare("UPDATE file_locks SET last_heartbeat_at = ?, expires_at = ? WHERE id = ?")
      .run(nowIso, expiresAt, fieldString(row, "id"));
    return toLockView(runtime, loadRow(runtime, fieldString(row, "id")) ?? row);
  });
}

export interface ReleaseLockInput {
  readonly lockId: string;
}

export function releaseLock(
  runtime: WorkspaceRuntime,
  actor: AuthenticatedActor,
  input: ReleaseLockInput,
): LockView {
  requireAuthorizedWorkspace(runtime, actor);
  const nowIso = nowIsoOf(runtime);
  return runtime.db.transaction<LockView>(() => {
    lazyExpireLocks(runtime);
    const row = loadRow(runtime, input.lockId.trim());
    if (row === undefined) {
      throw new DomainError("LOCK_NOT_HELD", "Lock nao encontrado.", {
        hint: "Use um lockId retornado por collab_lock_acquire.",
      });
    }
    assertOwned(actor, row);
    const status = fieldString(row, "status");
    if (status === "released") {
      return toLockView(runtime, row); // idempotente
    }
    if (status === "expired") {
      throw new DomainError("LOCK_EXPIRED", "Lock ja expirou; nada a liberar.", {
        hint: "Adquira um novo lock com collab_lock_acquire se ainda precisar editar.",
      });
    }
    runtime.db
      .prepare("UPDATE file_locks SET status = 'released', released_at = ? WHERE id = ?")
      .run(nowIso, fieldString(row, "id"));
    return toLockView(runtime, loadRow(runtime, fieldString(row, "id")) ?? row);
  });
}

export interface LockStatusInput {
  readonly path: string;
}

export function lockStatus(
  runtime: WorkspaceRuntime,
  actor: AuthenticatedActor,
  input: LockStatusInput,
): { path: NormalizedPath; held: LockView | null; ownedByCaller: boolean } {
  requireAuthorizedWorkspace(runtime, actor);
  const normalized = normalizeRelativePath(input.path);
  lazyExpireLocks(runtime);
  const row = loadHeld(runtime, actor.room.workspaceId, normalized.key);
  if (row === undefined) {
    return { path: normalized.display, held: null, ownedByCaller: false };
  }
  const view = toLockView(runtime, row);
  const ownedByCaller =
    fieldString(row, "agent_id") === String(actor.agent.id) &&
    fieldString(row, "session_id") === String(actor.session.id);
  return { path: normalized.display, held: view, ownedByCaller };
}

export function lockList(
  runtime: WorkspaceRuntime,
  actor: AuthenticatedActor,
): { locks: readonly LockView[] } {
  requireAuthorizedWorkspace(runtime, actor);
  lazyExpireLocks(runtime);
  const rows = runtime.db
    .prepare(
      `SELECT * FROM file_locks WHERE workspace_id = ? AND status = 'held'
       ORDER BY acquired_at ASC, id ASC`,
    )
    .all(actor.room.workspaceId);
  return { locks: rows.map((row) => toLockView(runtime, row)) };
}

export interface AssertUsableLockInput {
  readonly lockId: string;
  readonly workspaceId: WorkspaceId;
  readonly key: string;
}

/**
 * Usada por TODA mutacao: valida lockId + sessao/agente + workspace + caminho.
 * Nao e consultivo: sem isso, nenhuma escrita acontece.
 */
export function assertUsableLock(
  runtime: WorkspaceRuntime,
  actor: AuthenticatedActor,
  input: AssertUsableLockInput,
): LockView {
  // Defesa em camadas: mesmo chamado direto pelo servico exige autorizacao.
  requireAuthorizedWorkspace(runtime, actor);
  lazyExpireLocks(runtime);
  const row = loadRow(runtime, input.lockId.trim());
  if (row === undefined) {
    throw new DomainError("LOCK_NOT_HELD", "lockId invalido ou inexistente.", {
      hint: "Adquira um lock com collab_lock_acquire para ESTE arquivo e envie o lockId na mutacao.",
    });
  }
  const status = fieldString(row, "status");
  if (status === "expired") {
    throw new DomainError("LOCK_EXPIRED", "O lock expirou.", {
      hint: "Adquira um novo lock com collab_lock_acquire e RELEIA o arquivo antes de patchar.",
    });
  }
  if (status !== "held") {
    throw new DomainError("LOCK_NOT_HELD", "O lock nao esta ativo (ja liberado).", {
      hint: "Adquira um novo lock com collab_lock_acquire.",
    });
  }
  if (fieldString(row, "workspace_id") !== String(input.workspaceId)) {
    throw new DomainError("LOCK_NOT_HELD", "O lock pertence a outro workspace.", {
      hint: "Adquira um lock no workspace da sala autenticada.",
    });
  }
  if (fieldString(row, "path_key") !== input.key) {
    throw new DomainError("LOCK_NOT_HELD", "O lock e para OUTRO arquivo.", {
      hint: "Cada arquivo exige seu proprio lock; use collab_lock_acquire com o mesmo path.",
    });
  }
  if (
    fieldString(row, "agent_id") !== String(actor.agent.id) ||
    fieldString(row, "session_id") !== String(actor.session.id)
  ) {
    throw new DomainError("FORBIDDEN", "O lock pertence a outro agente/sessao.", {
      hint: "Somente o dono autenticado pode gravar com este lock. Negocie via collab_send_message.",
    });
  }
  return toLockView(runtime, row);
}
