import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  asNormalizedPath,
  DomainError,
  type NormalizedPath,
  type PrincipalId,
  type WorkspaceId,
} from "../contracts/index.js";
import type { WorkspaceCatalog } from "./catalog.js";
import type { WorkspaceRoot } from "./types.js";

/**
 * Validacao/canonicalizacao de caminhos — o nucleo de seguranca do modulo.
 *
 * ENTRADA DO CLIENTE = SOMENTE caminho RELATIVO ao workspace. Nunca aceitamos
 * absoluto, drive (C:), UNC (\\\\), `..`, NUL, caracteres de controle, ADS
 * (":") ou escapes apos normalizacao. Separadores `\` e `/` sao unificados
 * para `/` (estabilidade no Windows). A chave `key` e case-folded para que
 * `Login.html` e `login.html` (mesmo arquivo no Windows) compartilhem lock,
 * versao e historico.
 *
 * CONTENCAO: cada componente EXISTENTE e validado com `lstat` (sem seguir
 * link). Rejeitamos symlinks/junctions/reparse points e verificamos com
 * `realpathSync.native` que o caminho real continua dentro do root real e e
 * filho direto do pai esperado. Para arquivo NOVO, validamos o ancestral
 * existente mais proximo (o pai). Nunca seguimos links por padrao.
 */

export const MAX_PATH_LENGTH = 500;
/** Marcador de "arquivo ausente" (estado anterior de uma criacao). */
export const ABSENT_HASH = "";

export interface NormalizedRelativePath {
  readonly display: NormalizedPath;
  readonly key: string;
  readonly segments: readonly string[];
}

function pathError(message: string, hint: string): DomainError {
  return new DomainError("PATH_OUTSIDE_WORKSPACE", message, { hint });
}

function formatError(message: string, hint: string): DomainError {
  return new DomainError("VALIDATION_FAILED", message, { hint });
}

const HINT_RELATIVE =
  "Envie um caminho relativo ao workspace, separado por '/', sem '..' e sem raiz absoluta (ex.: src/login.html).";

/**
 * Nomes de dispositivo reservados do Windows (CON, NUL, COM1...) tambem com
 * extensao (`CON.txt`). Nao sao arquivos comuns e podem contornar a expectativa
 * de "arquivo dentro do workspace"; rejeitamos antes de tocar o filesystem.
 */
const WINDOWS_RESERVED_SEGMENT = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
/** Caracteres proibidos em nomes de arquivo do Windows. `:` e ADS (tratado antes). */
const WINDOWS_INVALID_FILENAME = /[<>"|?*]/;

export function normalizeRelativePath(input: string): NormalizedRelativePath {
  if (typeof input !== "string") {
    throw formatError("Caminho precisa ser texto.", HINT_RELATIVE);
  }
  const raw = input.trim();
  if (raw.length === 0) {
    throw formatError("Caminho vazio.", HINT_RELATIVE);
  }
  if (raw.length > MAX_PATH_LENGTH) {
    throw formatError(`Caminho excede ${MAX_PATH_LENGTH} caracteres.`, HINT_RELATIVE);
  }
  // NUL e caracteres de controle (inclusive \r\n) quebram resolucao/ADS.
  if (/[\x00-\x1f\x7f]/.test(raw)) {
    throw pathError("Caminho contem NUL ou caractere de controle.", HINT_RELATIVE);
  }
  // Absoluto POSIX, raiz Windows, UNC e drive (C: ou C:/...).
  if (raw.startsWith("/") || raw.startsWith("\\") || /^[A-Za-z]:/.test(raw)) {
    throw pathError("Caminho absoluto, de drive ou UNC nao permitido.", HINT_RELATIVE);
  }

  const unified = raw.replace(/\\/g, "/");
  const segments: string[] = [];
  for (const part of unified.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      throw pathError('Caminho contem ".." (path traversal).', HINT_RELATIVE);
    }
    // Dois pontos em segmento -> NTFS Alternate Data Stream / ambiguidade.
    if (part.includes(":")) {
      throw pathError("Caminho contem ':' (stream/ads nao permitido).", HINT_RELATIVE);
    }
    // Nomes que o Windows normaliza silenciosamente (trim de ponto/espaco).
    if (part.endsWith(".") || part.endsWith(" ")) {
      throw pathError("Segmento de caminho com ponto/espaco final nao permitido.", HINT_RELATIVE);
    }
    if (process.platform === "win32") {
      if (WINDOWS_INVALID_FILENAME.test(part)) {
        throw pathError(
          'Segmento contem caractere invalido no Windows (< > " | ? *).',
          HINT_RELATIVE,
        );
      }
      if (WINDOWS_RESERVED_SEGMENT.test(part)) {
        throw pathError(
          "Nome de dispositivo reservado do Windows (CON/NUL/COM1...) nao permitido.",
          "Use um nome de arquivo comum dentro do workspace.",
        );
      }
    }
    segments.push(part);
  }
  if (segments.length === 0) {
    throw formatError("Caminho nao aponta para nenhum arquivo.", HINT_RELATIVE);
  }
  const display = asNormalizedPath(segments.join("/"));
  return { display, key: display.toLowerCase(), segments };
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: string }).code === "ENOENT" ||
      (error as { code?: string }).code === "ENOTDIR")
  );
}

/** Detecta symlink e (no Windows) junction/reparse point via readlink. */
function isLinkOrReparse(component: string, stats: { isSymbolicLink(): boolean }): boolean {
  if (stats.isSymbolicLink()) return true;
  if (process.platform === "win32") {
    try {
      // Node consegue ler o alvo de junctions como links; em arquivo/dir
      // comum readlink lanca EINVAL/UNKNOWN.
      readlinkSync(component);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function caseFold(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

/** `child` esta contido em `root` (igual ou descendente, sem '..'). */
export function isContained(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  const folded = caseFold(rel);
  return folded !== ".." && !folded.startsWith(".." + path.sep);
}

/** `childReal` e filho DIRETO de `parentReal` com o nome esperado. */
function isDirectChildOf(parentReal: string, childReal: string, expectedSegment: string): boolean {
  const rel = path.relative(parentReal, childReal);
  return rel !== "" && caseFold(rel) === caseFold(expectedSegment);
}

export interface ResolvedPath {
  readonly root: WorkspaceRoot;
  readonly display: NormalizedPath;
  readonly key: string;
  /** Caminho absoluto no host (APENAS interno; nunca serializar). */
  readonly absolute: string;
  readonly exists: boolean;
  readonly isDirectory: boolean;
  /** realpath do ancestral existente mais proximo (pai, para arquivo novo). */
  readonly nearestExistingReal: string;
}

export interface ResolveWorkspacePathOptions {
  readonly catalog: WorkspaceCatalog;
  readonly workspaceId: WorkspaceId;
  readonly normalized: NormalizedRelativePath;
  /** true = permite que o componente final ainda nao exista (criacao). */
  readonly allowMissingFinal: boolean;
}

export function requireWorkspaceRoot(
  catalog: WorkspaceCatalog,
  workspaceId: WorkspaceId,
): WorkspaceRoot {
  const root = catalog.resolve(workspaceId);
  if (root === undefined) {
    throw new DomainError("NOT_FOUND", "Workspace da sala nao esta mais permitido no catalogo.", {
      hint: "O workspace pode ter sido removido da configuracao do servidor; peca ao operador para registrar um workspace valido.",
    });
  }
  return root;
}

/**
 * Camada BAIXA de autorizacao: exige que o workspace exista no catalogo E que
 * o principal de transporte conste na lista `allowedPrincipals` (fail-closed).
 *
 * Usado por TODA operacao de workspace/locking/checkpoint (via
 * `requireAuthorizedWorkspace` em files.ts e pelo `withActor` das tools), alem
 * de create/join/create_invite via `WorkspaceDirectory.principalCanAccess`.
 * A politica e relida a cada chamada: remover o principal (config revalidada)
 * bloqueia na PROXIMA operacao, sem apagar dados.
 */
export function resolveAuthorizedRoot(
  catalog: WorkspaceCatalog,
  workspaceId: WorkspaceId,
  principalId: PrincipalId,
): WorkspaceRoot {
  const root = requireWorkspaceRoot(catalog, workspaceId);
  catalog.assertPrincipalAllowed(workspaceId, principalId);
  return root;
}

/**
 * Resolve e VALIDA um caminho relativo contra o root real do workspace.
 * Nenhuma leitura/escrita de conteudo e feita aqui — apenas lstat/realpath.
 */
export function resolveWorkspacePath(options: ResolveWorkspacePathOptions): ResolvedPath {
  const root = requireWorkspaceRoot(options.catalog, options.workspaceId);
  const realRoot = root.realRoot;
  const { segments, display, key } = options.normalized;
  const absolute = path.resolve(realRoot, ...segments);

  if (!isContained(absolute, realRoot)) {
    throw pathError("Caminho normalizado escapa do workspace.", HINT_RELATIVE);
  }

  let current = realRoot;
  let currentReal = realRoot;
  let targetExists = false;
  let targetIsDirectory = false;
  const lastIndex = segments.length - 1;

  for (let i = 0; i <= lastIndex; i++) {
    const segment = segments[i];
    if (segment === undefined) break;
    const component = path.join(current, segment);
    let stats;
    try {
      stats = lstatSync(component);
    } catch (error) {
      if (isEnoent(error)) {
        if (i !== lastIndex || !options.allowMissingFinal) {
          // Para leitura: arquivo/diretorio inexistente.
          if (!options.allowMissingFinal) {
            throw new DomainError("NOT_FOUND", "Arquivo ou diretorio nao encontrado no workspace.", {
              hint: "Verifique o caminho relativo com collab_list_files / collab_read_file.",
            });
          }
          throw pathError(
            "Diretorio intermediario nao existe; criacao de diretorios nao suportada no MVP.",
            "Crie a pasta no host e tente novamente, ou use um caminho cujo pai ja exista.",
          );
        }
        break; // componente final novo; ancestral verificado = currentReal
      }
      throw new DomainError("INTERNAL", "Falha ao inspecionar componente do caminho.", {
        hint: "Verifique permissoes do workspace no host e tente novamente.",
        cause: error,
      });
    }

    if (isLinkOrReparse(component, stats)) {
      throw pathError(
        "Symlink/junction/reparse point no caminho nao e seguido por padrao.",
        "Use um caminho real dentro do workspace; links podem apontar para fora do root.",
      );
    }
    let componentReal: string;
    try {
      componentReal = realpathSync.native(component);
    } catch (error) {
      throw new DomainError("INTERNAL", "Falha ao resolver caminho real do componente.", {
        hint: "Verifique permissoes do workspace no host.",
        cause: error,
      });
    }
    if (!isContained(componentReal, realRoot)) {
      throw pathError("Componente do caminho escapa do root real (link).", HINT_RELATIVE);
    }
    if (!isDirectChildOf(currentReal, componentReal, segment)) {
      throw pathError(
        "Componente nao corresponde ao caminho esperado (possivel link/junction).",
        "Nao seguimos links; use o caminho real dentro do workspace.",
      );
    }
    if (i < lastIndex && !stats.isDirectory()) {
      throw pathError("Componente intermediario do caminho nao e um diretorio.", HINT_RELATIVE);
    }
    current = component;
    currentReal = componentReal;
    if (i === lastIndex) {
      targetExists = true;
      targetIsDirectory = stats.isDirectory();
    }
  }

  return {
    root,
    display,
    key,
    absolute,
    exists: targetExists,
    isDirectory: targetIsDirectory,
    nearestExistingReal: currentReal,
  };
}
