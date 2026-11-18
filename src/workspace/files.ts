import { lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  asNormalizedPath,
  DomainError,
  type NormalizedPath,
} from "../contracts/index.js";
import type { AuthenticatedActor } from "../collaboration/index.js";
import type { WorkspaceRuntime } from "./runtime.js";
import { decodeUtf8, hashOf, readDiskBytes, sha256Hex } from "./content.js";
import {
  isContained,
  normalizeRelativePath,
  resolveAuthorizedRoot,
  resolveWorkspacePath,
  type ResolvedPath,
  type NormalizedRelativePath,
} from "./paths.js";
import type { WorkspaceRoot } from "./types.js";
import {
  IGNORED_DIRECTORY_NAMES,
  IGNORED_FILE_SUFFIXES,
  type FileEntry,
  type FileReadResult,
  type ListFilesResult,
  type SearchFilesResult,
  type SearchMatch,
} from "./types.js";

/**
 * Camada de SERVICO de autorizacao por workspace.
 *
 * Confere em TODA operacao que (a) o workspace da sala ainda esta allowlisted
 * no catalogo e (b) o principal autenticado no transporte (`runtime.principalId`,
 * congelado no ToolContext da sessao MCP) consta em `allowedPrincipals`.
 * `runtime.principalId` e autoritativo: `authenticateCollaborationSession` ja
 * provou que a sessao de sala pertence a esse principal.
 *
 * E chamado por list/read/search/patch/create/restore, locks e checkpoints —
 * alem do `withActor` das tools (defesa em camadas). A decisao e relida a cada
 * chamada, entao remover o principal da config revalidada bloqueia a PROXIMA
 * operacao sem apagar salas, versoes ou historico.
 */
export function requireAuthorizedWorkspace(
  runtime: WorkspaceRuntime,
  actor: AuthenticatedActor,
): WorkspaceRoot {
  return resolveAuthorizedRoot(
    runtime.catalog,
    actor.room.workspaceId,
    runtime.principalId,
  );
}

/** Alias historico mantido para compatibilidade de codigo interno. */
export const requireAllowedWorkspace = requireAuthorizedWorkspace;

/** Resolve um caminho relativo do cliente para o workspace autorizado da sala. */
export function resolveForActor(
  runtime: WorkspaceRuntime,
  actor: AuthenticatedActor,
  pathInput: string,
  allowMissingFinal: boolean,
): { normalized: NormalizedRelativePath; resolved: ResolvedPath } {
  requireAllowedWorkspace(runtime, actor);
  const normalized = normalizeRelativePath(pathInput);
  const resolved = resolveWorkspacePath({
    catalog: runtime.catalog,
    workspaceId: actor.room.workspaceId,
    normalized,
    allowMissingFinal,
  });
  return { normalized, resolved };
}

function isIgnoredDirectory(name: string): boolean {
  return IGNORED_DIRECTORY_NAMES.includes(name);
}

function isIgnoredFile(name: string): boolean {
  return IGNORED_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

interface SafeEntry {
  readonly name: string;
  readonly absolute: string;
  readonly relative: NormalizedPath;
  readonly isDirectory: boolean;
  readonly sizeBytes: number;
}

/**
 * `readdirSync` seguro: nao segue symlinks/junctions e descarta qualquer filho
 * cujo realpath escape do root real. Usado por list/search (varredura).
 */
function safeReaddir(
  dirAbsolute: string,
  realRoot: string,
  relativePrefix: string,
): readonly SafeEntry[] {
  let names: string[];
  try {
    names = readdirSync(dirAbsolute);
  } catch {
    return [];
  }
  const entries: SafeEntry[] = [];
  for (const name of names) {
    const childAbsolute = path.join(dirAbsolute, name);
    let stats;
    try {
      stats = lstatSync(childAbsolute);
    } catch {
      continue;
    }
    if (stats.isSymbolicLink()) continue;
    if (process.platform === "win32") {
      try {
        readlinkSync(childAbsolute); // junction/reparse point
        continue;
      } catch {
        // arquivo/diretorio comum
      }
    }
    let childReal: string;
    try {
      childReal = realpathSync.native(childAbsolute);
    } catch {
      continue;
    }
    if (!isContained(childReal, realRoot)) continue;
    if (isIgnoredDirectory(name) && stats.isDirectory()) continue;
    if (!stats.isDirectory() && isIgnoredFile(name)) continue;
    const relative = asNormalizedPath(
      relativePrefix === "" ? name : `${relativePrefix}/${name}`,
    );
    entries.push({
      name,
      absolute: childAbsolute,
      relative,
      isDirectory: stats.isDirectory(),
      sizeBytes: stats.isDirectory() ? 0 : stats.size,
    });
  }
  return entries;
}

function normalizeOptionalLimit(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new DomainError("VALIDATION_FAILED", "Limite invalido.", {
      hint: `Use um inteiro entre 1 e ${max}.`,
    });
  }
  return Math.min(value, max);
}

function normalizeOffset(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new DomainError("VALIDATION_FAILED", "offset invalido.", {
      hint: "Use um inteiro >= 0 (valor de nextOffset retornado por collab_list_files).",
    });
  }
  return value;
}

/** Profundidade e SEMPRE limitada pelo maxDepth configurado no servidor. */
function normalizeDepth(value: number | undefined, configuredMax: number): number {
  if (value === undefined) return configuredMax;
  if (!Number.isInteger(value) || value < 0) {
    throw new DomainError("VALIDATION_FAILED", "depth invalido.", {
      hint: `Use um inteiro entre 0 e ${configuredMax}.`,
    });
  }
  return Math.min(value, configuredMax);
}

export interface ListFilesInput {
  readonly path?: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly depth?: number;
}

export function listFiles(
  runtime: WorkspaceRuntime,
  actor: AuthenticatedActor,
  input: ListFilesInput = {},
): ListFilesResult {
  const root = requireAllowedWorkspace(runtime, actor);
  const limit = normalizeOptionalLimit(input.limit, 100, runtime.limits.maxListEntries);
  const offset = normalizeOffset(input.offset);
  const maxDepth = normalizeDepth(input.depth, runtime.limits.maxDepth);

  let startAbsolute = root.realRoot;
  let relativePrefix = "";
  if (input.path !== undefined && input.path.trim() !== "") {
    const { resolved } = resolveForActor(runtime, actor, input.path, false);
    if (!resolved.isDirectory) {
      throw new DomainError("VALIDATION_FAILED", "path precisa ser um diretorio.", {
        hint: "Use collab_read_file para arquivos ou aponte para uma pasta existente.",
      });
    }
    startAbsolute = resolved.absolute;
    relativePrefix = String(resolved.display);
  }

  const collected: FileEntry[] = [];
  const queue: Array<{ absolute: string; prefix: string; depth: number }> = [
    { absolute: startAbsolute, prefix: relativePrefix, depth: 0 },
  ];

  while (queue.length > 0 && collected.length < runtime.limits.maxListEntries) {
    const current = queue.shift();
    if (current === undefined) break;
    const children = safeReaddir(current.absolute, root.realRoot, current.prefix);
    for (const child of children) {
      collected.push({
        path: child.relative,
        isDirectory: child.isDirectory,
        sizeBytes: child.sizeBytes,
      });
      if (collected.length >= runtime.limits.maxListEntries) break;
      if (child.isDirectory && current.depth < maxDepth) {
        queue.push({
          absolute: child.absolute,
          prefix: String(child.relative),
          depth: current.depth + 1,
        });
      }
    }
  }

  collected.sort((a, b) => String(a.path).localeCompare(String(b.path)));
  const page = collected.slice(offset, offset + limit);
  return {
    entries: page,
    offset,
    limit,
    total: collected.length,
    hasMore: offset + page.length < collected.length,
  };
}

export interface ReadFileInput {
  readonly path: string;
}

export function readFile(
  runtime: WorkspaceRuntime,
  actor: AuthenticatedActor,
  input: ReadFileInput,
): FileReadResult {
  const { resolved } = resolveForActor(runtime, actor, input.path, false);
  if (resolved.isDirectory) {
    throw new DomainError("VALIDATION_FAILED", "O caminho aponta para um diretorio.", {
      hint: "Use collab_list_files para diretorios e collab_read_file para arquivos.",
    });
  }
  let stats;
  try {
    stats = lstatSync(resolved.absolute);
  } catch (error) {
    // Nunca propague a mensagem crua do Node: ENOENT/EACCES inclui caminho absoluto.
    throw new DomainError("NOT_FOUND", "Arquivo nao encontrado no workspace.", {
      hint: "Confira o caminho relativo com collab_list_files e tente novamente.",
      cause: error,
    });
  }
  if (stats.size > runtime.limits.maxFileBytes) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `Arquivo excede o limite de ${runtime.limits.maxFileBytes} bytes.`,
      { hint: "Reduza o arquivo ou aumente maxFileBytes na composicao do servidor." },
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = readDiskBytes(resolved.absolute);
  } catch (error) {
    throw new DomainError("INTERNAL", "Falha ao ler o arquivo no host.", {
      hint: "Verifique permissoes do workspace no servidor e tente novamente.",
      cause: error,
    });
  }
  const hash = hashOf(bytes);
  const content = decodeUtf8(bytes, runtime.limits.maxFileBytes);

  const latest = runtime.db
    .prepare(
      `SELECT version, hash FROM file_versions
       WHERE workspace_id = ? AND path_key = ?
       ORDER BY version DESC LIMIT 1`,
    )
    .get(actor.room.workspaceId, resolved.key) as { version: number; hash: string } | undefined;
  const version = latest?.version ?? 0;
  const tracked = latest !== undefined && latest.hash === String(hash);

  return {
    path: resolved.display,
    hash,
    version,
    tracked,
    sizeBytes: bytes.length,
    encoding: "utf-8",
    content,
    ...(tracked
      ? {}
      : {
          notice:
            "Arquivo ainda sem versao registrada OU alterado fora do MCP desde a ultima versao. " +
            "Use o hash retornado como expectedHash em collab_apply_patch.",
        }),
  };
}

export interface SearchFilesInput {
  readonly query: string;
  readonly mode?: "name" | "content" | "both";
  readonly path?: string;
  readonly limit?: number;
}

function lineSnippet(line: string, query: string, index: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(line.length, index + query.length + 40);
  return `${start > 0 ? "..." : ""}${line.slice(start, end)}${end < line.length ? "..." : ""}`;
}

export function searchFiles(
  runtime: WorkspaceRuntime,
  actor: AuthenticatedActor,
  input: SearchFilesInput,
): SearchFilesResult {
  const root = requireAllowedWorkspace(runtime, actor);
  const query = input.query.trim();
  if (query.length === 0 || query.length > 500) {
    throw new DomainError("VALIDATION_FAILED", "query invalida.", {
      hint: "Use uma busca de 1 a 500 caracteres.",
    });
  }
  const mode = input.mode ?? "both";
  const limit = normalizeOptionalLimit(input.limit, 25, runtime.limits.maxSearchResults);
  const foldedQuery = query.toLowerCase();

  let startAbsolute = root.realRoot;
  let relativePrefix = "";
  if (input.path !== undefined && input.path.trim() !== "") {
    const { resolved } = resolveForActor(runtime, actor, input.path, false);
    if (!resolved.isDirectory) {
      throw new DomainError("VALIDATION_FAILED", "path precisa ser um diretorio.", {
        hint: "Aponte para uma pasta existente para limitar a busca.",
      });
    }
    startAbsolute = resolved.absolute;
    relativePrefix = String(resolved.display);
  }

  const matches: SearchMatch[] = [];
  let filesScanned = 0;
  let truncated = false;
  const queue: Array<{ absolute: string; prefix: string; depth: number }> = [
    { absolute: startAbsolute, prefix: relativePrefix, depth: 0 },
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    const children = safeReaddir(current.absolute, root.realRoot, current.prefix);
    for (const child of children) {
      if (child.isDirectory) {
        if (current.depth < runtime.limits.maxDepth) {
          queue.push({
            absolute: child.absolute,
            prefix: String(child.relative),
            depth: current.depth + 1,
          });
        }
        if (mode !== "content" && String(child.relative).toLowerCase().includes(foldedQuery)) {
          matches.push({ path: child.relative, kind: "name" });
        }
        continue;
      }

      filesScanned += 1;
      if (filesScanned > runtime.limits.maxSearchFiles) {
        truncated = true;
        break;
      }
      if (mode !== "content" && String(child.relative).toLowerCase().includes(foldedQuery)) {
        matches.push({ path: child.relative, kind: "name" });
      }
      if (mode !== "name" && matches.length < limit) {
        if (child.sizeBytes > runtime.limits.maxFileBytes) continue;
        let text: string;
        try {
          text = decodeUtf8(readDiskBytes(child.absolute), runtime.limits.maxFileBytes);
        } catch {
          continue; // binario: ignorado na busca de conteudo
        }
        const lines = text.split(/\r?\n/);
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const line = lines[lineIndex];
          if (line === undefined) continue;
          const index = line.toLowerCase().indexOf(foldedQuery);
          if (index >= 0) {
            matches.push({
              path: child.relative,
              kind: "content",
              line: lineIndex + 1,
              snippet: lineSnippet(line, query, index),
            });
            if (matches.length >= limit) break;
          }
        }
      }
      if (matches.length >= limit || filesScanned > runtime.limits.maxSearchFiles) {
        if (matches.length >= limit) truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  return { matches: matches.slice(0, limit), filesScanned, truncated };
}

/** Leitura usada por mutacoes: retorna bytes/hash/texto do estado ATUAL. */
export function readForMutation(
  runtime: WorkspaceRuntime,
  resolved: ResolvedPath,
): { bytes: Uint8Array; hash: string; text: string } {
  let bytes: Uint8Array;
  try {
    bytes = readDiskBytes(resolved.absolute);
  } catch (error) {
    // Erro de filesystem nao pode vazar caminho absoluto na resposta MCP.
    throw new DomainError("INTERNAL", "Falha ao ler o arquivo atual do host.", {
      hint: "Verifique permissoes/estado do arquivo no workspace e releia antes de gravar.",
      cause: error,
    });
  }
  const hash = sha256Hex(bytes);
  const text = decodeUtf8(bytes, runtime.limits.maxFileBytes);
  return { bytes, hash, text };
}
