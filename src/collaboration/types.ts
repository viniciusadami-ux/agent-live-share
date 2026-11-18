import type {
  AgentId,
  ClientKind,
  Cursor,
  FileChangeKind,
  IsoDateTime,
  JsonValue,
  MessageId,
  MessageKind,
  PrincipalId,
  Role,
  RoomId,
  SessionId,
  TaskId,
  TaskStatus,
  WorkspaceId,
} from "../contracts/index.js";

/**
 * Tipos publicos do modulo de colaboracao.
 *
 * IDs de recursos proprios deste modulo (convite, solicitacao e handoff) nao
 * existem em `src/contracts` (que nao deve ser alterado nesta frente); por isso
 * sao strings opacas. Os demais IDs reutilizam os tipos branded da fundacao.
 *
 * Adaptacoes locais deliberadas:
 * - `SessionView.status` usa "active" | "revoked" | "expired" porque o
 *   `SessionStatus` da fundacao nao possui "revoked";
 * - `AgentView.clientKind` espelha o campo `Agent.client` da fundacao usando o
 *   nome recebido no ingresso (`clientKind`);
 * - `releasedLocks`/`retainedLocks` do handoff ficam vazios ate a frente de
 *   locking existir.
 */

export interface AgentView {
  readonly id: AgentId;
  readonly displayName: string;
  readonly clientKind: ClientKind;
  readonly createdAt: IsoDateTime;
}

export interface RoomView {
  readonly id: RoomId;
  readonly name: string;
  readonly workspaceId: WorkspaceId;
  readonly coordinatorAgentId: AgentId;
  readonly createdByAgentId: AgentId;
  readonly createdAt: IsoDateTime;
}

/** Vinculo do agente com a sala, sem dados de presenca. */
export interface ParticipantIdentity {
  readonly roomId: RoomId;
  readonly agentId: AgentId;
  readonly roles: readonly Role[];
  readonly active: boolean;
  readonly joinedAt: IsoDateTime;
}

export interface ParticipantView extends ParticipantIdentity {
  readonly displayName: string;
  readonly clientKind: ClientKind;
  readonly coordinator: boolean;
  readonly activeSessionCount: number;
  readonly lastSeenAt?: IsoDateTime;
}

export type CollaborationSessionStatus = "active" | "revoked" | "expired";

export interface SessionView {
  readonly id: SessionId;
  readonly roomId: RoomId;
  readonly agentId: AgentId;
  readonly status: CollaborationSessionStatus;
  readonly createdAt: IsoDateTime;
  readonly lastHeartbeatAt: IsoDateTime;
  readonly expiresAt: IsoDateTime;
  readonly revokedAt?: IsoDateTime;
}

/**
 * Resultado da autenticacao consumido pelas ferramentas e pelo modulo de
 * workspace. `roles` e `isCoordinator` sao derivados do participante e da sala
 * a cada chamada; nunca sao aceitos do chamador.
 */
export interface AuthenticatedActor {
  readonly session: SessionView;
  readonly agent: AgentView;
  readonly room: RoomView;
  readonly participant: ParticipantIdentity;
  readonly roles: readonly Role[];
  readonly isCoordinator: boolean;
}

/**
 * Entrada PUBLICA do servico. O `principalId` NAO vem do chamador: e
 * injetado pelo servico a partir do contexto autenticado (ver `CreateRoomCommand`).
 */
export interface CreateRoomInput {
  readonly displayName: string;
  readonly clientKind?: ClientKind;
  readonly roomName: string;
  /** Identificador OPERACIONAL de workspace; nunca um caminho do host. */
  readonly workspaceId: string;
}

/** Comando INTERNO: principal derivado do transporte, nunca do modelo. */
export type CreateRoomCommand = CreateRoomInput & { readonly principalId: PrincipalId };

export interface CreateRoomResult {
  readonly agent: AgentView;
  readonly room: RoomView;
  readonly participant: ParticipantView;
  readonly session: SessionView;
  /** Texto puro retornado UMA vez; o servidor persiste apenas o hash. */
  readonly sessionToken: string;
}

export type InviteStatus = "active" | "expired" | "exhausted" | "revoked";

export interface InviteView {
  readonly id: string;
  readonly roomId: RoomId;
  readonly roles: readonly Role[];
  readonly createdByAgentId: AgentId;
  readonly createdAt: IsoDateTime;
  readonly expiresAt: IsoDateTime;
  readonly maxUses: number;
  readonly uses: number;
  readonly revokedAt?: IsoDateTime;
  readonly status: InviteStatus;
}

export interface CreateInviteInput {
  /** Ingresso normal e sempre worker; reviewer e opcional. */
  readonly reviewer?: boolean;
  readonly expiresInMinutes?: number;
  readonly maxUses?: number;
}

export interface CreateInviteResult {
  readonly invite: InviteView;
  /** Texto puro retornado UMA vez; o servidor persiste apenas o hash. */
  readonly inviteToken: string;
}

export interface JoinRoomInput {
  readonly inviteToken: string;
  readonly displayName: string;
  readonly clientKind?: ClientKind;
}

/** Comando INTERNO: vincula o ingresso ao principal autenticado no transporte. */
export type JoinRoomCommand = JoinRoomInput & { readonly principalId: PrincipalId };

export interface JoinRoomResult {
  readonly agent: AgentView;
  readonly room: RoomView;
  readonly participant: ParticipantView;
  readonly session: SessionView;
  readonly inviteId: string;
  /** Texto puro retornado UMA vez; o servidor persiste apenas o hash. */
  readonly sessionToken: string;
}

export interface HeartbeatResult {
  readonly session: SessionView;
  readonly renewedUntil: IsoDateTime;
}

export interface LeaveResult {
  readonly sessionId: SessionId;
  readonly status: "revoked";
  readonly revokedAt: IsoDateTime;
}

export interface RoomStateSelf {
  readonly agent: AgentView;
  readonly roles: readonly Role[];
  readonly session: SessionView;
}

export type TaskSummary = Readonly<Record<TaskStatus, number>>;

export interface RoomStateView {
  readonly room: RoomView;
  readonly coordinator: AgentView;
  readonly self: RoomStateSelf;
  readonly participants: readonly ParticipantView[];
  readonly taskSummary: TaskSummary;
}

export interface TransferCoordinatorResult {
  readonly room: RoomView;
  readonly previousCoordinatorAgentId: AgentId;
  readonly newCoordinator: ParticipantView;
}

export interface MessageView {
  readonly id: MessageId;
  readonly roomId: RoomId;
  readonly fromAgentId: AgentId;
  readonly toAgentId?: AgentId;
  readonly kind: MessageKind;
  readonly correlationId?: MessageId;
  readonly body: string;
  readonly payload?: Readonly<Record<string, JsonValue>>;
  readonly cursor: Cursor;
  readonly createdAt: IsoDateTime;
}

export interface SendMessageInput {
  readonly body: string;
  /** Ausente = mensagem da sala (broadcast). */
  readonly toAgentId?: string;
  readonly kind?: "chat" | "decision";
}

export interface SendMessageResult {
  readonly message: MessageView;
}

export type RequestKind = "plan";
export type RequestStatus = "open" | "answered" | "closed";

export interface RequestView {
  readonly id: string;
  readonly roomId: RoomId;
  readonly fromAgentId: AgentId;
  readonly toAgentId: AgentId;
  readonly kind: RequestKind;
  readonly status: RequestStatus;
  readonly subject: string;
  readonly details?: string;
  readonly requestMessageId: MessageId;
  readonly responseMessageId?: MessageId;
  readonly responseBody?: string;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export interface RequestPlanInput {
  readonly subject: string;
  readonly details?: string;
}

export interface RequestResult {
  readonly request: RequestView;
  readonly message: MessageView;
}

export interface RespondToRequestInput {
  readonly requestId: string;
  readonly body: string;
}

export interface ListRequestsOptions {
  readonly status?: RequestStatus;
  readonly limit?: number;
}

export interface EventView {
  readonly cursor: Cursor;
  readonly type: string;
  readonly visibility: "room" | "direct" | "self";
  readonly actorAgentId?: AgentId;
  readonly targetAgentId?: AgentId;
  readonly messageId?: MessageId;
  readonly taskId?: TaskId;
  readonly requestId?: string;
  readonly handoffId?: string;
  readonly payload: Readonly<Record<string, JsonValue>>;
  readonly createdAt: IsoDateTime;
}

export interface GetUpdatesInput {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface UpdatesPage {
  readonly events: readonly EventView[];
  readonly nextCursor: Cursor;
  readonly hasMore: boolean;
}

export interface TaskView {
  readonly id: TaskId;
  readonly roomId: RoomId;
  readonly title: string;
  readonly description?: string;
  readonly status: TaskStatus;
  readonly assigneeAgentId?: AgentId;
  readonly createdByAgentId: AgentId;
  readonly dependsOn: readonly TaskId[];
  readonly blockedReason?: string;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
  readonly completedAt?: IsoDateTime;
  readonly handoffCount: number;
  readonly latestHandoffId?: string;
}

export interface ProposeTaskInput {
  readonly title: string;
  readonly description?: string;
  readonly assigneeAgentId?: string;
  readonly dependsOn?: readonly string[];
}

export interface AssignTaskInput {
  readonly taskId: string;
  readonly assigneeAgentId: string;
}

export type TaskAction =
  | "accept"
  | "start"
  | "block"
  | "unblock"
  | "progress"
  | "complete"
  | "cancel";

export interface UpdateTaskInput {
  readonly taskId: string;
  readonly action: TaskAction;
  /** Nota de progresso/bloqueio; obrigatoria para `progress` e `block`. */
  readonly note?: string;
  /** Justificativa opcional para `cancel`; reutiliza `note` quando ausente. */
  readonly reason?: string;
}

export interface TaskUpdateResult {
  readonly task: TaskView;
  readonly handoff?: HandoffView;
  readonly message?: MessageView;
}

export interface ListTasksOptions {
  readonly status?: TaskStatus;
  readonly assigneeAgentId?: string;
  readonly limit?: number;
}

export interface HandoffChange {
  readonly path: string;
  readonly kind: FileChangeKind;
}

export interface RetainedLockView {
  readonly lockId: string;
  readonly reason: string;
}

export interface HandoffTest {
  readonly name: string;
  readonly passed: boolean;
}

export type HandoffReviewStatus =
  | "not_requested"
  | "pending"
  | "approved"
  | "changes_requested";

export interface HandoffView {
  readonly id: string;
  readonly roomId: RoomId;
  readonly taskId: TaskId;
  readonly fromAgentId: AgentId;
  readonly objective: string;
  readonly changes: readonly HandoffChange[];
  readonly releasedLocks: readonly string[];
  readonly retainedLocks: readonly RetainedLockView[];
  readonly tests: readonly HandoffTest[];
  readonly decisions: readonly string[];
  readonly knownIssues: readonly string[];
  readonly reusable: readonly string[];
  readonly pending: readonly string[];
  readonly nextStep?: string;
  readonly reviewStatus: HandoffReviewStatus;
  readonly reviewedByAgentId?: AgentId;
  readonly reviewNotes?: string;
  readonly reviewedAt?: IsoDateTime;
  readonly createdAt: IsoDateTime;
}

export interface SubmitHandoffInput {
  readonly taskId: string;
  readonly objective: string;
  readonly changes?: readonly HandoffChange[];
  readonly tests?: readonly HandoffTest[];
  readonly decisions?: readonly string[];
  readonly knownIssues?: readonly string[];
  readonly reusable?: readonly string[];
  readonly pending?: readonly string[];
  readonly nextStep?: string;
  readonly requestReview?: boolean;
}

export type HandoffDecision = "approved" | "changes_requested";

export interface ReviewHandoffInput {
  readonly handoffId: string;
  readonly decision: HandoffDecision;
  readonly notes?: string;
}

export interface ListHandoffsOptions {
  readonly taskId?: string;
  readonly limit?: number;
}

/** Resultado da avaliacao de suficiencia usada para concluir tarefas. */
export interface HandoffSufficiency {
  readonly sufficient: boolean;
  readonly missing: readonly string[];
}
