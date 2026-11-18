import { lstatSync, statSync } from "node:fs";
import {
  asFileVersionId,
  asContentHash,
  asIsoDateTime,
  DomainError,
  type AgentId,
  type NormalizedPath,
  type WorkspaceId,
} from "../contracts/index.js";
import type { SqlRow } from "../persistence/index.js";
import type { WorkspaceRuntime } from "./runtime.js";
import { newWorkspaceObjectId } from "./catalog.js";
import { hashOf, readDiskState } from "./content.js";
import {
  normalizeRelativePath,
  resolveAuthorizedRoot,
  resolveWorkspacePath,
  type ResolvedPath,
} from "./paths.js";
import {
  fieldBoolean,
  fieldBytes,
  fieldNumber,
  fieldOptionalNumber,
  fieldOptionalString,
  fieldString,
} from "./rows.js";
import type {
  FileHistoryResult,
  FileVersionView,
  MutationResult,
} from "./types.js";

/**
 * Versoes, BACKUP persistente e JOURNAL de recuperacao.
 *
 * Modelo: cada mutacao bem-sucedida publica em `file_versions`
 *  - um estado "pre" (o conteudo EXATO anterior a esta mutacao) quando o estado
 *    atual ainda nao estava registrado (primeira mutacao ou edicao externa);
 *  - um estado "post" (novo conteudo), com autor/sessao/lock/metadados.
 * O conteudo integral fica no BLOB `content` = backup em SQLite (nao criamos
 * arquivos de backup dentro do workspace). Historico NUNCA e apagado:
 * restaurar = publicar um NOVO estado "post".
 *
 * ESTRATEGIA TRANSACIONAL (SQLite + filesystem nao formam uma transacao):
 *  T1 (SQLite): grava `file_pending_writes` com o backup (previous_content) E
 *      o conteudo pretendido (next_content) + plano de versoes. COMMIT ANTES
 *      de tocar o disco => o conteudo antigo nunca se perde.
 *  FS: grava next_content em temporario no MESMO diretorio (flag 'wx') e faz
 *      rename atomico sobre o destino. Se falhar: remove temporario, apaga o
 *      journal e NAO publica versao alguma (original intacto, sem versao falsa).
 *  T2 (SQLite): publica as linhas pre/post em `file_versions` e apaga o
 *      journal, em uma unica transacao.
 *  RECUPERACAO: se o processo cair entre FS e T2, `recoverPendingWrites`
 *      (chamada na composicao e no inicio de cada mutacao) compara o hash do
 *      disco com next_hash/previous_hash: finaliza T2, descarta a intencao ou
 *      mantem o journal bloqueante para revisao manual (nunca adivinha).
 */

export interface VersionPlan {
  readonly baseVersion: number;
  readonly preNeeded: boolean;
  readonly preVersion: number;
  readonly postVersion: number;
  readonly parentVersion: number | null;
}

export function latestVersion(
  db: WorkspaceRuntime["db"],
  workspaceId: WorkspaceId,
  key: string,
): { version: number; hash: string; existed: boolean } | undefined {
  const row = db
    .prepare(
      `SELECT version, hash, existed FROM file_versions
       WHERE workspace_id = ? AND path_key = ?
       ORDER BY version DESC LIMIT 1`,
    )
    .get(workspaceId, key) as SqlRow | undefined;
  if (row === undefined) return undefined;
  return {
    version: fieldNumber(row, "version"),
    hash: fieldString(row, "hash"),
    existed: fieldBoolean(row, "existed"),
  };
}

export function buildVersionPlan(
  db: WorkspaceRuntime["db"],
  workspaceId: WorkspaceId,
  key: string,
  currentHash: string,
  currentExisted: boolean,
): VersionPlan {
  const latest = latestVersion(db, workspaceId, key);
  const baseVersion = latest?.version ?? 0;
  const matches =
    latest !== undefined &&
    latest.hash === currentHash &&
    latest.existed === currentExisted;
  const preNeeded = !matches;
  const preVersion = preNeeded ? baseVersion + 1 : 0;
  const postVersion = preNeeded ? baseVersion + 2 : baseVersion + 1;
  const parentVersion = preNeeded ? preVersion : baseVersion > 0 ? baseVersion : null;
  return { baseVersion, preNeeded, preVersion, postVersion, parentVersion };
}

export interface PendingWrite {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly path: string;
  readonly key: string;
  readonly expectedHash: string;
  readonly previousExisted: boolean;
  readonly previousHash: string;
  readonly previousContent: Uint8Array | null;
  readonly nextExisted: boolean;
  readonly nextHash: string;
  readonly nextContent: Uint8Array | null;
  readonly baseVersion: number;
  readonly preNeeded: boolean;
  readonly preVersion: number;
  readonly postVersion: number;
  readonly parentVersion: number | null;
  readonly kind: string;
  readonly createdByAgentId: AgentId | undefined;
  readonly sessionId: string | undefined;
  readonly roomId: string | undefined;
  readonly lockId: string | undefined;
  readonly note?: string;
  readonly createdAt: string;
}

function pendingFromRow(row: SqlRow): PendingWrite {
  return {
    id: fieldString(row, "id"),
    workspaceId: fieldString(row, "workspace_id") as WorkspaceId,
    path: fieldString(row, "path"),
    key: fieldString(row, "path_key"),
    expectedHash: fieldString(row, "expected_hash"),
    previousExisted: fieldBoolean(row, "previous_existed"),
    previousHash: fieldString(row, "previous_hash"),
    previousContent: fieldBytes(row, "previous_content"),
    nextExisted: fieldBoolean(row, "next_existed"),
    nextHash: fieldString(row, "next_hash"),
    nextContent: fieldBytes(row, "next_content"),
    baseVersion: fieldNumber(row, "base_version"),
    preNeeded: fieldBoolean(row, "pre_needed"),
    preVersion: fieldNumber(row, "pre_version"),
    postVersion: fieldNumber(row, "post_version"),
    parentVersion: fieldOptionalNumber(row, "parent_version") ?? null,
    kind: fieldString(row, "kind"),
    createdByAgentId: fieldOptionalString(row, "created_by_agent_id") as AgentId | undefined,
    sessionId: fieldOptionalString(row, "session_id"),
    roomId: fieldOptionalString(row, "room_id"),
    lockId: fieldOptionalString(row, "lock_id"),
    note: fieldOptionalString(row, "note"),
    createdAt: fieldString(row, "created_at"),
  };
}

/** T1: journal duravel (backup + intencao) ANTES de qualquer escrita em disco. */
export function insertPendingWrite(runtime: WorkspaceRuntime, pending: PendingWrite): void {
  runtime.db
    .prepare(
      `INSERT INTO file_pending_writes (
         id, workspace_id, path, path_key, expected_hash,
         previous_existed, previous_hash, previous_content,
         next_existed, next_hash, next_content,
         base_version, pre_needed, pre_version, post_version, parent_version,
         kind, created_by_agent_id, session_id, room_id, lock_id, note, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      pending.id,
      pending.workspaceId,
      pending.path,
      pending.key,
      pending.expectedHash,
      pending.previousExisted ? 1 : 0,
      pending.previousHash,
      pending.previousContent === null ? null : Buffer.from(pending.previousContent),
      pending.nextExisted ? 1 : 0,
      pending.nextHash,
      pending.nextContent === null ? null : Buffer.from(pending.nextContent),
      pending.baseVersion,
      pending.preNeeded ? 1 : 0,
      pending.preVersion,
      pending.postVersion,
      pending.parentVersion,
      pending.kind,
      pending.createdByAgentId ?? null,
      pending.sessionId ?? null,
      pending.roomId ?? null,
      pending.lockId ?? null,
      pending.note ?? null,
      pending.createdAt,
    );
}

export function deletePendingWrite(db: WorkspaceRuntime["db"], id: string): void {
  db.prepare("DELETE FROM file_pending_writes WHERE id = ?").run(id);
}

/**
 * T2 (ou recuperacao): publica pre/post em `file_versions` e apaga o journal.
 * Roda em uma transacao; conflito de UNIQUE deixa o journal intacto para nova
 * recuperacao/revisao (nao registra versao falsa).
 */
export function finalizeVersionRows(runtime: WorkspaceRuntime, pending: PendingWrite): void {
  runtime.db.transaction(() => {
    if (pending.preNeeded) {
      runtime.db
        .prepare(
          `INSERT INTO file_versions (
             id, workspace_id, path, path_key, version, hash, size_bytes, existed,
             content, kind, parent_version, mutation_id, created_by_agent_id,
             session_id, room_id, lock_id, note, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pre_mutation', ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          newWorkspaceObjectId("fv"),
          pending.workspaceId,
          pending.path,
          pending.key,
          pending.preVersion,
          pending.previousHash,
          pending.previousContent?.length ?? 0,
          pending.previousExisted ? 1 : 0,
          pending.previousContent === null ? null : Buffer.from(pending.previousContent),
          pending.baseVersion > 0 ? pending.baseVersion : null,
          pending.id,
          "Estado anterior a primeira mutacao via MCP / alteracao externa.",
          pending.createdAt,
        );
    }
    runtime.db
      .prepare(
        `INSERT INTO file_versions (
           id, workspace_id, path, path_key, version, hash, size_bytes, existed,
           content, kind, parent_version, mutation_id, created_by_agent_id,
           session_id, room_id, lock_id, note, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newWorkspaceObjectId("fv"),
        pending.workspaceId,
        pending.path,
        pending.key,
        pending.postVersion,
        pending.nextHash,
        pending.nextContent?.length ?? 0,
        pending.nextExisted ? 1 : 0,
        pending.nextContent === null ? null : Buffer.from(pending.nextContent),
        pending.kind,
        pending.parentVersion,
        pending.id,
        pending.createdByAgentId ?? null,
        pending.sessionId ?? null,
        pending.roomId ?? null,
        pending.lockId ?? null,
        pending.note ?? null,
        pending.createdAt,
      );
    deletePendingWrite(runtime.db, pending.id);
  });
}

function diskExists(absolute: string): boolean {
  try {
    lstatSync(absolute);
    return true;
  } catch {
    return false;
  }
}

export interface RecoveryFilter {
  readonly workspaceId: WorkspaceId;
  readonly key: string;
}

/**
 * Recuperacao conservadora de journals interrompidos. Nao lanca: journals
 * indecidiveis ficam no banco e bloqueiam novas mutacoes naquele caminho.
 */
export function recoverPendingWrites(
  runtime: WorkspaceRuntime,
  filter?: RecoveryFilter,
): void {
  const rows =
    filter === undefined
      ? runtime.db.prepare("SELECT * FROM file_pending_writes ORDER BY created_at ASC").all()
      : runtime.db
          .prepare(
            `SELECT * FROM file_pending_writes
             WHERE workspace_id = ? AND path_key = ? ORDER BY created_at ASC`,
          )
          .all(filter.workspaceId, filter.key);

  for (const row of rows) {
    const pending = pendingFromRow(row);
    // Recuperacao e uma operacao de manutencao, mas NAO pode ser disparada por
    // um principal sem acesso ao workspace: ele nao deve finalizar/descartar
    // journals de outro workspace so por abrir uma sessao MCP.
    if (!runtime.catalog.principalCanAccess(pending.workspaceId, runtime.principalId)) {
      continue;
    }
    let resolved: ResolvedPath;
    try {
      const normalized = normalizeRelativePath(pending.path);
      resolved = resolveWorkspacePath({
        catalog: runtime.catalog,
        workspaceId: pending.workspaceId,
        normalized,
        allowMissingFinal: true,
      });
    } catch {
      continue; // workspace removido ou caminho agora inseguro: mantem journal
    }
    const exists = diskExists(resolved.absolute);
    let hash = "";
    try {
      if (exists) {
        if (statSync(resolved.absolute).size > runtime.limits.maxFileBytes) continue;
        hash = readDiskState(resolved.absolute, true).hash;
      }
    } catch {
      continue;
    }

    try {
      if (pending.nextExisted && exists && hash === pending.nextHash) {
        // Escrita em disco concluiu, mas T2 nao: publica as versoes agora.
        finalizeVersionRows(runtime, pending);
      } else if (
        (!pending.previousExisted && !exists) ||
        (exists && hash === pending.previousHash)
      ) {
        // Escrita nunca aconteceu: conteudo original intacto, descarta intencao.
        deletePendingWrite(runtime.db, pending.id);
      }
      // Caso contrario: disco foi alterado externamente -> mantem journal.
    } catch {
      // UNIQUE/conflito: mantem journal para revisao manual.
    }
  }
}

export function hasBlockingPending(
  db: WorkspaceRuntime["db"],
  workspaceId: WorkspaceId,
  key: string,
): boolean {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS total FROM file_pending_writes WHERE workspace_id = ? AND path_key = ?",
    )
    .get(workspaceId, key) as SqlRow | undefined;
  return row !== undefined && fieldNumber(row, "total") > 0;
}

export function assertNoBlockingPending(
  runtime: WorkspaceRuntime,
  workspaceId: WorkspaceId,
  key: string,
): void {
  if (hasBlockingPending(runtime.db, workspaceId, key)) {
    throw new DomainError(
      "INTERNAL",
      "Existe uma escrita pendente nao recuperada para este arquivo.",
      {
        hint:
          "O disco foi alterado fora do MCP apos uma interrupcao. Revise o arquivo e o journal " +
          "file_pending_writes no host antes de novas mutacoes (o historico nao foi apagado).",
      },
    );
  }
}

function toVersionView(row: SqlRow): FileVersionView {
  return {
    id: asFileVersionId(fieldString(row, "id")),
    version: fieldNumber(row, "version"),
    hash: asContentHash(fieldString(row, "hash")),
    sizeBytes: fieldNumber(row, "size_bytes"),
    existed: fieldBoolean(row, "existed"),
    kind: fieldString(row, "kind"),
    parentVersion: fieldOptionalNumber(row, "parent_version"),
    createdByAgentId: fieldOptionalString(row, "created_by_agent_id") as AgentId | undefined,
    createdAt: asIsoDateTime(fieldString(row, "created_at")),
    note: fieldOptionalString(row, "note"),
  };
}

export interface FileHistoryInput {
  readonly path: string;
  readonly limit?: number;
}

export function fileHistory(
  runtime: WorkspaceRuntime,
  workspaceId: WorkspaceId,
  input: FileHistoryInput,
): FileHistoryResult {
  // Chamadas diretas ao servico tambem precisam respeitar a allowlist E a
  // autorizacao por principal vigentes (fail-closed).
  resolveAuthorizedRoot(runtime.catalog, workspaceId, runtime.principalId);
  const normalized = normalizeRelativePath(input.path);
  const limit =
    input.limit === undefined
      ? runtime.limits.maxHistoryEntries
      : Math.max(1, Math.min(input.limit, runtime.limits.maxHistoryEntries));
  const rows = runtime.db
    .prepare(
      `SELECT id, version, hash, size_bytes, existed, kind, parent_version,
              created_by_agent_id, created_at, note
       FROM file_versions
       WHERE workspace_id = ? AND path_key = ?
       ORDER BY version DESC LIMIT ?`,
    )
    .all(workspaceId, normalized.key, limit);
  return {
    path: normalized.display,
    versions: rows.map(toVersionView),
  };
}

export interface StoredVersionContent {
  readonly bytes: Uint8Array;
  readonly hash: string;
  readonly existed: boolean;
}

export function findVersionContent(
  runtime: WorkspaceRuntime,
  workspaceId: WorkspaceId,
  key: string,
  version: number,
): StoredVersionContent | undefined {
  const row = runtime.db
    .prepare(
      `SELECT content, hash, existed FROM file_versions
       WHERE workspace_id = ? AND path_key = ? AND version = ?`,
    )
    .get(workspaceId, key, version) as SqlRow | undefined;
  if (row === undefined) return undefined;
  const bytes = fieldBytes(row, "content");
  return {
    bytes: bytes ?? new Uint8Array(),
    hash: fieldString(row, "hash"),
    existed: fieldBoolean(row, "existed"),
  };
}

/** Resultado padrao de mutacao (sem expor root absoluto). */
export function mutationResult(
  display: NormalizedPath,
  pending: PendingWrite,
  extra: { replacementsApplied?: number; restoredFromVersion?: number },
): MutationResult {
  return {
    path: display,
    hash: hashOf(pending.nextContent ?? new Uint8Array()),
    version: pending.postVersion,
    previousHash: pending.previousHash,
    previousVersion: pending.preVersion > 0 ? pending.preVersion : pending.baseVersion,
    ...extra,
    notice:
      "Versao anterior preservada no historico. Libere o lock e publique um handoff ao concluir.",
  };
}
