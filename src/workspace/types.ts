import type {
  ContentHash,
  FileVersionId,
  IsoDateTime,
  LockId,
  NormalizedPath,
  RoomId,
  WorkspaceId,
  AgentId,
  TaskId,
  PrincipalId,
} from "../contracts/index.js";

/**
 * Tipos PUBLICOS do modulo de workspace/locking. Nenhuma forma de dado aqui
 * contem `rootPath`, caminho absoluto do host, token ou conteudo de arquivo em
 * campos de metadado. O conteudo aparece SOMENTE em `FileReadResult.content`
 * (leitura autorizada) e nunca em historico, locks, eventos ou auditoria.
 */

export interface WorkspaceDefinition {
  /** Identificador OPACO (nunca um caminho). Ex.: "migracao-2026". */
  readonly id: string;
  readonly name: string;
  /** Caminho ABSOLUTO do diretorio no HOST; configurado SOMENTE no servidor. */
  readonly rootPath: string;
  /**
   * IDs de Principal (Bearer) autorizados a acessar ESTE workspace.
   * Configurado SOMENTE no servidor (`workspaces.json`); NUNCA aceito de tool.
   *
   * FAIL-CLOSED: campo ausente, null ou array vazio => NENHUM principal
   * autorizado. Nao ha wildcard nem "permitir todos". IDs sao validados no
   * startup contra `isPrincipalIdFormat` (`prin_...`); entradas invalidas ou
   * duplicadas derrubam o startup.
   *
   * A revogacao da credencial (transporte) continua bloqueando o acesso;
   * remover um ID daqui bloqueia as proximas operacoes de workspace/lock/
   * checkpoint sem apagar salas, sessoes, versoes ou historico.
   */
  readonly allowedPrincipals?: readonly PrincipalId[];
}

export interface WorkspaceSummary {
  readonly id: WorkspaceId;
  readonly name: string;
}

/** Root interno do servidor. `realRoot` NUNCA sai do processo. */
export interface WorkspaceRoot {
  readonly id: WorkspaceId;
  readonly name: string;
  readonly realRoot: string;
}

export interface FileEntry {
  readonly path: NormalizedPath;
  readonly isDirectory: boolean;
  readonly sizeBytes: number;
}

export interface ListFilesResult {
  readonly entries: readonly FileEntry[];
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  readonly hasMore: boolean;
}

export interface FileReadResult {
  readonly path: NormalizedPath;
  /** SHA-256 hexadecimal do conteudo atual EM DISCO. */
  readonly hash: ContentHash;
  /** Ultimo numero de versao registrado (0 = ainda sem historico via MCP). */
  readonly version: number;
  /** False quando o arquivo foi alterado fora do MCP desde a ultima versao. */
  readonly tracked: boolean;
  readonly sizeBytes: number;
  readonly encoding: "utf-8";
  readonly content: string;
  readonly notice?: string;
}

export interface SearchMatch {
  readonly path: NormalizedPath;
  readonly kind: "name" | "content";
  readonly line?: number;
  readonly snippet?: string;
}

export interface SearchFilesResult {
  readonly matches: readonly SearchMatch[];
  readonly filesScanned: number;
  readonly truncated: boolean;
}

export interface PatchReplacement {
  readonly oldText: string;
  readonly newText: string;
  /** Padrao 1. O numero EXATO de ocorrencias nao-sobrepostas exigido. */
  readonly expectedOccurrences?: number;
}

export interface MutationResult {
  readonly path: NormalizedPath;
  readonly hash: ContentHash;
  readonly version: number;
  readonly previousHash: string;
  readonly previousVersion: number;
  readonly replacementsApplied?: number;
  readonly restoredFromVersion?: number;
  readonly notice: string;
}

export interface FileVersionView {
  readonly id: FileVersionId;
  readonly version: number;
  readonly hash: ContentHash;
  readonly sizeBytes: number;
  readonly existed: boolean;
  readonly kind: string;
  readonly parentVersion?: number;
  readonly createdByAgentId?: AgentId;
  readonly createdAt: IsoDateTime;
  readonly note?: string;
}

export interface FileHistoryResult {
  readonly path: NormalizedPath;
  readonly versions: readonly FileVersionView[];
}

export type CheckpointStatus = "open" | "sealed" | "failed";

export interface CheckpointView {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly roomId: RoomId;
  readonly status: CheckpointStatus;
  readonly createdByAgentId: AgentId;
  readonly note?: string;
  readonly testResults?: Readonly<Record<string, unknown>>;
  readonly createdAt: IsoDateTime;
  readonly sealedAt?: IsoDateTime;
  readonly sealedByAgentId?: AgentId;
}

export interface LockView {
  readonly id: LockId;
  readonly path: NormalizedPath;
  readonly workspaceId: WorkspaceId;
  readonly roomId: RoomId;
  readonly agentId: AgentId;
  readonly agentDisplayName: string;
  readonly taskId?: TaskId;
  readonly intent: string;
  readonly status: "held" | "released" | "expired";
  readonly acquiredAt: IsoDateTime;
  readonly lastHeartbeatAt: IsoDateTime;
  readonly expiresAt: IsoDateTime;
  readonly releasedAt?: IsoDateTime;
}

export interface LockAcquireResult {
  readonly lock: LockView;
  /** True quando o mesmo dono ja possuia o lock e apenas renovou o TTL. */
  readonly reacquired: boolean;
}

/** Limites operacionais (configuraveis na composicao, com defaults seguros). */
export interface WorkspaceLimits {
  /** Tamanho maximo de arquivo lido/escrito (bytes). */
  readonly maxFileBytes: number;
  /** Maximo de entradas coletadas em uma listagem. */
  readonly maxListEntries: number;
  /** Profundidade maxima de varredura de diretorios. */
  readonly maxDepth: number;
  /** Maximo de arquivos varridos em uma busca. */
  readonly maxSearchFiles: number;
  /** Maximo de resultados de busca. */
  readonly maxSearchResults: number;
  /** Maximo de substituicoes por patch. */
  readonly maxPatchReplacements: number;
  /** Tamanho maximo de oldText/newText (caracteres). */
  readonly maxPatchTextLength: number;
  /** Maximo de versoes retornadas no historico. */
  readonly maxHistoryEntries: number;
  /** TTL padrao do lock (ms); renovavel via collab_lock_renew. */
  readonly lockTtlMs: number;
  /** Tamanho maximo do campo intent. */
  readonly maxIntentLength: number;
}

export const DEFAULT_WORKSPACE_LIMITS: WorkspaceLimits = {
  maxFileBytes: 1_000_000,
  maxListEntries: 500,
  maxDepth: 8,
  maxSearchFiles: 2000,
  maxSearchResults: 100,
  maxPatchReplacements: 50,
  maxPatchTextLength: 200_000,
  maxHistoryEntries: 100,
  lockTtlMs: 5 * 60_000,
  maxIntentLength: 500,
} as const;

/** Diretorios ignorados por padrao em list/busca (regra simples documentada). */
export const IGNORED_DIRECTORY_NAMES: readonly string[] = [
  ".git",
  "node_modules",
  ".collab-mcp",
  "data",
] as const;

/** Extensoes ignoradas (bancos/backups internos que nao sao codigo). */
export const IGNORED_FILE_SUFFIXES: readonly string[] = [
  ".sqlite",
  ".sqlite-wal",
  ".sqlite-shm",
  ".tmp-collab-write",
] as const;
