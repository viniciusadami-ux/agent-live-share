import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  DomainError,
  type AgentId,
} from "../contracts/index.js";
import type { AuthenticatedActor } from "../collaboration/index.js";
import type { WorkspaceRuntime } from "./runtime.js";
import { decodeUtf8, encodeUtf8, sha256Hex } from "./content.js";
import { readForMutation, requireAuthorizedWorkspace, resolveForActor } from "./files.js";
import { ABSENT_HASH, type ResolvedPath } from "./paths.js";
import {
  assertNoBlockingPending,
  buildVersionPlan,
  deletePendingWrite,
  finalizeVersionRows,
  findVersionContent,
  insertPendingWrite,
  mutationResult,
  recoverPendingWrites,
  type PendingWrite,
} from "./versions.js";
import { assertNotPaused } from "./checkpoints.js";
import { assertUsableLock } from "../locking/locks.js";
import type { MutationResult, PatchReplacement } from "./types.js";

/**
 * Mutacoes de workspace: patch delimitado, criacao explicita e restauracao.
 *
 * TODA mutacao exige, nesta ordem:
 *  1) sessao autenticada (feito na tool);
 *  2) workspace da sala ainda permitido (resolveForActor);
 *  3) nenhum checkpoint aberto (assertNotPaused);
 *  4) caminho contido no root real, sem symlink (resolveWorkspacePath);
 *  5) lockId valido, do MESMO agente/sessao/workspace/caminho (assertUsableLock);
 *  6) recuperacao de journals + nenhum journal bloqueante;
 *  7) expectedHash == hash ATUAL do disco (HASH_MISMATCH caso contrario).
 *
 * Escrita two-phase (detalhada em versions.ts): journal T1 -> temp+rename ->
 * versoes T2. Falha de filesystem => temporario removido, journal apagado,
 * NENHUMA versao publicada e conteudo original intacto.
 */

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface MutationSpec {
  readonly path: string;
  readonly lockId: string;
  readonly mode: "create" | "update" | "restore";
  readonly expectedHash?: string;
  readonly content?: string;
  readonly replacements?: readonly PatchReplacement[];
  readonly restoreVersion?: number;
  readonly note?: string;
}

interface PreviousState {
  readonly existed: boolean;
  readonly hash: string;
  readonly bytes: Uint8Array | null;
}

interface NextState {
  readonly existed: boolean;
  readonly hash: string;
  readonly bytes: Uint8Array;
}

function validateHash(expectedHash: string | undefined): string {
  if (expectedHash === undefined || !HASH_PATTERN.test(expectedHash)) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "expectedHash e obrigatorio e precisa ser o SHA-256 (64 hex) da ultima leitura.",
      {
        hint: "Chame collab_read_file DEPOIS de adquirir o lock e envie o campo hash retornado como expectedHash.",
      },
    );
  }
  return expectedHash;
}

/** Aplica substituicoes EXATAS, atomicamente, sem parser de unified diff. */
export function applyReplacements(
  text: string,
  replacements: readonly PatchReplacement[],
  limits: WorkspaceRuntime["limits"],
): string {
  if (replacements.length === 0 || replacements.length > limits.maxPatchReplacements) {
    throw new DomainError("VALIDATION_FAILED", "Lista de substituicoes invalida.", {
      hint: `Envie de 1 a ${limits.maxPatchReplacements} substituicoes {oldText,newText,expectedOccurrences?}.`,
    });
  }
  interface Range {
    readonly start: number;
    readonly end: number;
    readonly newText: string;
  }
  const ranges: Range[] = [];
  for (const replacement of replacements) {
    const oldText = replacement.oldText;
    const newText = replacement.newText ?? "";
    if (
      typeof oldText !== "string" ||
      oldText.length === 0 ||
      oldText.length > limits.maxPatchTextLength ||
      oldText.includes("\0")
    ) {
      throw new DomainError("PATCH_NOT_APPLICABLE", "oldText invalido.", {
        hint: `oldText precisa ter 1..${limits.maxPatchTextLength} caracteres, sem NUL, e nao pode ser vazio.`,
      });
    }
    if (typeof newText !== "string" || newText.length > limits.maxPatchTextLength || newText.includes("\0")) {
      throw new DomainError("VALIDATION_FAILED", "newText invalido.", {
        hint: `newText precisa ter ate ${limits.maxPatchTextLength} caracteres e nao pode conter NUL.`,
      });
    }
    const expected =
      replacement.expectedOccurrences === undefined ? 1 : replacement.expectedOccurrences;
    if (!Number.isInteger(expected) || expected < 1) {
      throw new DomainError("VALIDATION_FAILED", "expectedOccurrences invalido.", {
        hint: "Use um inteiro >= 1 (padrao 1).",
      });
    }
    // Ocorrencias NAO sobrepostas no texto ORIGINAL.
    const found: number[] = [];
    let position = 0;
    while (position <= text.length) {
      const index = text.indexOf(oldText, position);
      if (index < 0) break;
      found.push(index);
      position = index + oldText.length;
    }
    if (found.length !== expected) {
      throw new DomainError(
        "PATCH_NOT_APPLICABLE",
        `Substituicao esperava ${expected} ocorrencia(s), encontrou ${found.length}.`,
        {
          hint:
            "Recoloque oldText exatamente como esta no arquivo (inclusive espacos/quebras) e releia o arquivo antes de patchar. " +
            "Zero ou multiplas ocorrencias sao rejeitadas para evitar substituicao ambigua.",
        },
      );
    }
    for (const start of found) {
      ranges.push({ start, end: start + oldText.length, newText });
    }
  }

  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i += 1) {
    const previous = ranges[i - 1];
    const current = ranges[i];
    if (previous === undefined || current === undefined) continue;
    if (current.start < previous.end) {
      throw new DomainError(
        "PATCH_NOT_APPLICABLE",
        "Substituicoes sobrepostas/ambiguas; o patch nao pode ser aplicado com seguranca.",
        {
          hint: "Separe as substituicoes em regioes nao sobrepostas ou ajuste expectedOccurrences.",
        },
      );
    }
  }

  let result = "";
  let cursor = 0;
  for (const range of ranges) {
    result += text.slice(cursor, range.start) + range.newText;
    cursor = range.end;
  }
  result += text.slice(cursor);
  return result;
}

function computeUpdate(spec: MutationSpec, currentText: string, limits: WorkspaceRuntime["limits"]): string {
  if (spec.replacements === undefined || spec.replacements.length === 0) {
    throw new DomainError("VALIDATION_FAILED", "replacements e obrigatorio para patch.", {
      hint: "Envie pelo menos uma substituicao {oldText,newText,expectedOccurrences?}.",
    });
  }
  return applyReplacements(currentText, spec.replacements, limits);
}

function computeNext(
  runtime: WorkspaceRuntime,
  spec: MutationSpec,
  resolved: ResolvedPath,
  previous: PreviousState,
  currentText: string | undefined,
): { next: NextState; replacementsApplied?: number; restoredFromVersion?: number } {
  let text: string;
  let replacementsApplied: number | undefined;
  let restoredFromVersion: number | undefined;

  switch (spec.mode) {
    case "create": {
      if (spec.content === undefined) {
        throw new DomainError("VALIDATION_FAILED", "content e obrigatorio para criacao.", {
          hint: "Envie o conteudo UTF-8 do novo arquivo no campo content.",
        });
      }
      text = spec.content;
      break;
    }
    case "update": {
      text = computeUpdate(spec, currentText ?? "", runtime.limits);
      replacementsApplied = spec.replacements?.length ?? 0;
      break;
    }
    case "restore": {
      const version = spec.restoreVersion;
      if (version === undefined || !Number.isInteger(version) || version < 1) {
        throw new DomainError("VALIDATION_FAILED", "restoreVersion invalido.", {
          hint: "Informe o numero de versao retornado por collab_file_history.",
        });
      }
      const stored = findVersionContent(runtime, resolved.root.id, resolved.key, version);
      if (stored === undefined) {
        throw new DomainError("NOT_FOUND", "Versao solicitada nao existe no historico.", {
          hint: "Use collab_file_history para listar as versoes disponiveis deste arquivo.",
        });
      }
      if (!stored.existed) {
        throw new DomainError("VALIDATION_FAILED", "Nao e possivel restaurar um estado 'ausente'.", {
          hint: "Restauracao para ausencia (delete) nao existe no MVP; escolha uma versao com conteudo.",
        });
      }
      // Conteudo vem do BACKUP persistido; validado como texto UTF-8.
      text = decodeUtf8(stored.bytes, runtime.limits.maxFileBytes);
      restoredFromVersion = version;
      break;
    }
  }

  const bytes = encodeUtf8(text);
  if (bytes.length > runtime.limits.maxFileBytes) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `Resultado excede o limite de ${runtime.limits.maxFileBytes} bytes.`,
      { hint: "Reduza o conteudo/patch ou aumente maxFileBytes na composicao do servidor." },
    );
  }
  // Garante UTF-8 valido (ex.: newText nao introduziu sequencia invalida).
  decodeUtf8(bytes, runtime.limits.maxFileBytes);
  const hash = sha256Hex(bytes);
  if (previous.existed && hash === previous.hash) {
    throw new DomainError("PATCH_NOT_APPLICABLE", "O patch nao altera o conteudo do arquivo.", {
      hint: "Envie substituicoes que de fato modifiquem o arquivo; nenhuma versao foi criada.",
    });
  }
  return {
    next: { existed: true, hash, bytes },
    ...(replacementsApplied === undefined ? {} : { replacementsApplied }),
    ...(restoredFromVersion === undefined ? {} : { restoredFromVersion }),
  };
}

export function performMutation(
  runtime: WorkspaceRuntime,
  actor: AuthenticatedActor,
  spec: MutationSpec,
): MutationResult {
  const workspaceId = actor.room.workspaceId;
  // Autorizacao ANTES de qualquer outra checagem: um principal removido nao
  // deve nem descobrir se ha checkpoint aberto/lock pendente no workspace.
  requireAuthorizedWorkspace(runtime, actor);
  assertNotPaused(runtime, workspaceId);

  const allowMissingFinal = spec.mode === "create";
  const { resolved } = resolveForActor(runtime, actor, spec.path, allowMissingFinal);

  // Lock nao e consultivo: valida identidade, workspace e caminho.
  assertUsableLock(runtime, actor, {
    lockId: spec.lockId,
    workspaceId,
    key: resolved.key,
  });

  // Recuperacao lazy de journals + recusa conservadora se houver pendencia.
  recoverPendingWrites(runtime, { workspaceId, key: resolved.key });
  assertNoBlockingPending(runtime, workspaceId, resolved.key);

  let previous: PreviousState;
  let currentText: string | undefined;
  if (spec.mode === "create") {
    if (resolved.exists) {
      throw new DomainError("ALREADY_EXISTS", "Arquivo ja existe; criacao exige ausencia.", {
        hint: "Use collab_apply_patch para alterar um arquivo existente, ou escolha outro caminho.",
      });
    }
    previous = { existed: false, hash: ABSENT_HASH, bytes: null };
  } else {
    const expectedHash = validateHash(spec.expectedHash);
    const current = readForMutation(runtime, resolved);
    if (current.hash !== expectedHash) {
      throw new DomainError(
        "HASH_MISMATCH",
        "expectedHash desatualizado: o arquivo mudou desde a sua leitura.",
        {
          hint:
            "Mesmo com lock valido, RELEIA o arquivo com collab_read_file e envie o novo hash como expectedHash. " +
            "Isso impede sobrescrever trabalho alheio/edicao externa.",
        },
      );
    }
    previous = { existed: true, hash: current.hash, bytes: current.bytes };
    currentText = current.text;
  }

  const computed = computeNext(runtime, spec, resolved, previous, currentText);
  const plan = buildVersionPlan(runtime.db, workspaceId, resolved.key, previous.hash, previous.existed);
  const now = runtime.now().toISOString();
  const mutationId = `mut_${randomUUID()}`;

  const pending: PendingWrite = {
    id: mutationId,
    workspaceId,
    path: String(resolved.display),
    key: resolved.key,
    expectedHash: previous.hash,
    previousExisted: previous.existed,
    previousHash: previous.hash,
    previousContent: previous.bytes,
    nextExisted: computed.next.existed,
    nextHash: computed.next.hash,
    nextContent: computed.next.bytes,
    baseVersion: plan.baseVersion,
    preNeeded: plan.preNeeded,
    preVersion: plan.preVersion,
    postVersion: plan.postVersion,
    parentVersion: plan.parentVersion,
    kind: spec.mode === "create" ? "create" : spec.mode === "restore" ? "restore" : "patch",
    createdByAgentId: actor.agent.id as AgentId,
    sessionId: String(actor.session.id),
    roomId: String(actor.room.id),
    lockId: spec.lockId.trim(),
    note:
      spec.note?.trim() ||
      (spec.mode === "restore"
        ? `Restauracao da versao ${computed.restoredFromVersion ?? "?"}.`
        : undefined),
    createdAt: now,
  };

  // T1: journal duravel (backup + intencao) ANTES de tocar o disco.
  insertPendingWrite(runtime, pending);

  // FS: temporario no MESMO diretorio + rename atomico.
  const tempName = `.${path.basename(resolved.absolute)}.${randomUUID()}.tmp-collab-write`;
  let temp: string | undefined;
  try {
    temp = runtime.fs.writeTemp(resolved.absolute, tempName, computed.next.bytes);
    runtime.fs.replace(temp, resolved.absolute);
    temp = undefined;
  } catch (error) {
    if (temp !== undefined) runtime.fs.cleanup(temp);
    // Nenhuma versao publicada; original intacto; journal descartado.
    deletePendingWrite(runtime.db, pending.id);
    throw new DomainError(
      "INTERNAL",
      "Falha ao gravar no disco; nenhuma alteracao foi aplicada e nenhuma versao foi registrada.",
      {
        hint: "O arquivo original foi preservado. Verifique permissoes/espaco em disco e tente novamente.",
        cause: error,
      },
    );
  }

  // T2: publica pre/post e remove o journal.
  try {
    finalizeVersionRows(runtime, pending);
  } catch (error) {
    // Escrita aconteceu, mas o historico ficou pendente: recuperacao conservadora.
    throw new DomainError(
      "INTERNAL",
      "Conteudo gravado, mas o registro de versao ficou pendente de recuperacao.",
      {
        hint: "O journal file_pending_writes sera finalizado na proxima operacao; nao repita o patch sem conferir o historico.",
        cause: error,
      },
    );
  }

  return mutationResult(resolved.display, pending, {
    ...(computed.replacementsApplied === undefined
      ? {}
      : { replacementsApplied: computed.replacementsApplied }),
    ...(computed.restoredFromVersion === undefined
      ? {}
      : { restoredFromVersion: computed.restoredFromVersion }),
  });
}

export interface ApplyPatchInput {
  readonly path: string;
  readonly lockId: string;
  readonly expectedHash: string;
  readonly replacements: readonly PatchReplacement[];
  readonly note?: string;
}

export function applyPatch(
  runtime: WorkspaceRuntime,
  actor: AuthenticatedActor,
  input: ApplyPatchInput,
): MutationResult {
  return performMutation(runtime, actor, {
    path: input.path,
    lockId: input.lockId,
    mode: "update",
    expectedHash: input.expectedHash,
    replacements: input.replacements,
    note: input.note,
  });
}

export interface CreateFileInput {
  readonly path: string;
  readonly lockId: string;
  readonly content: string;
  readonly note?: string;
}

export function createFile(
  runtime: WorkspaceRuntime,
  actor: AuthenticatedActor,
  input: CreateFileInput,
): MutationResult {
  return performMutation(runtime, actor, {
    path: input.path,
    lockId: input.lockId,
    mode: "create",
    content: input.content,
    note: input.note,
  });
}

export interface RestoreVersionInput {
  readonly path: string;
  readonly lockId: string;
  readonly expectedHash: string;
  readonly version: number;
  readonly note?: string;
}

export function restoreVersion(
  runtime: WorkspaceRuntime,
  actor: AuthenticatedActor,
  input: RestoreVersionInput,
): MutationResult {
  return performMutation(runtime, actor, {
    path: input.path,
    lockId: input.lockId,
    mode: "restore",
    expectedHash: input.expectedHash,
    restoreVersion: input.version,
    note: input.note,
  });
}
