/**
 * Formas de dados dos conceitos genericos do nucleo.
 *
 * ESTA ETAPA DEFINE SOMENTE CONTRATOS. Nao ha persistencia, validacao,
 * regras de lock, heartbeat, patch, cursor ou checkpoint implementadas aqui.
 * Os modulos `collaboration`, `workspace` e `locking` consomem estes tipos.
 */
import type {
  AgentId,
  CheckpointId,
  ContentHash,
  Cursor,
  FileVersionId,
  IsoDateTime,
  LockId,
  MessageId,
  NormalizedPath,
  RoomId,
  SessionId,
  TaskId,
  WorkspaceId,
} from "./ids.js";
import type { ClientKind, JsonValue } from "./primitives.js";
import type { Role } from "./roles.js";

export type SessionStatus = "active" | "paused" | "closed" | "expired";
export type TaskStatus =
  | "proposed"
  | "accepted"
  | "in_progress"
  | "blocked"
  | "completed"
  | "cancelled";
export type MessageKind =
  | "chat"
  | "request"
  | "response"
  | "decision"
  | "progress"
  | "blocker"
  | "handoff";
export type LockStatus = "held" | "released" | "expired";
export type CheckpointStatus = "open" | "sealed" | "failed";
export type FileChangeKind = "created" | "modified" | "deleted";

/** Identidade de um agente. `client` e metadado, nao permissao. */
export interface Agent {
  readonly id: AgentId;
  readonly displayName: string;
  readonly client: ClientKind;
  readonly createdAt: IsoDateTime;
}

/** Sessao ativa de um agente; heartbeats ficam a cargo do modulo de colaboracao. */
export interface Session {
  readonly id: SessionId;
  readonly agentId: AgentId;
  readonly roomId: RoomId;
  readonly status: SessionStatus;
  readonly createdAt: IsoDateTime;
  readonly lastHeartbeatAt: IsoDateTime;
}

/** Participante de uma sala e seus papeis (pelo menos um coordinator por sala). */
export interface Participant {
  readonly roomId: RoomId;
  readonly agentId: AgentId;
  readonly roles: readonly Role[];
  readonly joinedAt: IsoDateTime;
}

/** Workspace allowlisted SOMENTE no servidor; agentes nao escolhem a raiz. */
export interface Workspace {
  readonly id: WorkspaceId;
  readonly displayName: string;
  readonly rootPath: string;
  readonly createdAt: IsoDateTime;
}

export interface Room {
  readonly id: RoomId;
  readonly name: string;
  readonly workspaceId: WorkspaceId;
  readonly coordinatorAgentId: AgentId;
  readonly createdAt: IsoDateTime;
}

export interface Task {
  readonly id: TaskId;
  readonly roomId: RoomId;
  readonly title: string;
  readonly description?: string;
  readonly status: TaskStatus;
  readonly assigneeAgentId?: AgentId;
  readonly dependsOn: readonly TaskId[];
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

/** Mensagem da sala ou direta; `toAgentId` ausente = destinada a sala. */
export interface Message {
  readonly id: MessageId;
  readonly roomId: RoomId;
  readonly fromAgentId: AgentId;
  readonly toAgentId?: AgentId;
  readonly kind: MessageKind;
  /** Correlaciona response/decisao com a request original. */
  readonly correlationId?: MessageId;
  readonly body: string;
  readonly payload?: Readonly<Record<string, JsonValue>>;
  /** Posicao ordenavel para consulta "desde um cursor". */
  readonly cursor: Cursor;
  readonly createdAt: IsoDateTime;
}

/** Lock exclusivo de escrita por arquivo (heartbeat + expiracao). */
export interface FileLock {
  readonly id: LockId;
  readonly workspaceId: WorkspaceId;
  readonly path: NormalizedPath;
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly taskId?: TaskId;
  readonly intent: string;
  readonly status: LockStatus;
  readonly acquiredAt: IsoDateTime;
  readonly lastHeartbeatAt: IsoDateTime;
  readonly expiresAt: IsoDateTime;
  readonly releasedAt?: IsoDateTime;
}

/** Versao/hash de conteudo usada para rejeitar gravacoes desatualizadas. */
export interface FileVersion {
  readonly id: FileVersionId;
  readonly workspaceId: WorkspaceId;
  readonly path: NormalizedPath;
  readonly version: number;
  readonly hash: ContentHash;
  readonly sizeBytes: number;
  readonly createdByAgentId: AgentId;
  readonly createdAt: IsoDateTime;
  readonly parentVersion?: number;
}

/** Checkpoint global estavel antes de testes/build/commit. */
export interface Checkpoint {
  readonly id: CheckpointId;
  readonly roomId: RoomId;
  readonly status: CheckpointStatus;
  readonly createdByAgentId: AgentId;
  readonly participants: readonly AgentId[];
  readonly changedPaths: readonly NormalizedPath[];
  readonly testResults?: Readonly<Record<string, JsonValue>>;
  readonly notes?: string;
  readonly createdAt: IsoDateTime;
  readonly sealedAt?: IsoDateTime;
}

/** Handoff obrigatorio ao concluir uma unidade de trabalho (secao 16 do plano). */
export interface Handoff {
  readonly roomId: RoomId;
  readonly taskId: TaskId;
  readonly fromAgentId: AgentId;
  readonly objective: string;
  readonly changes: readonly {
    readonly path: NormalizedPath;
    readonly kind: FileChangeKind;
  }[];
  readonly releasedLocks: readonly LockId[];
  readonly retainedLocks: readonly {
    readonly lockId: LockId;
    readonly reason: string;
  }[];
  readonly tests: readonly { readonly name: string; readonly passed: boolean }[];
  readonly decisions: readonly string[];
  readonly knownIssues: readonly string[];
  readonly reusable: readonly string[];
  readonly pending: readonly string[];
  readonly nextStep?: string;
  readonly createdAt: IsoDateTime;
}
