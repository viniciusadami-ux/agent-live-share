import type { PrincipalId } from "../contracts/index.js";
import type { DatabaseConnection } from "../persistence/index.js";
import { authenticateCollaborationSession } from "./auth.js";
import type { CollaborationRuntime } from "./context.js";
import { readAuthorizedUpdates } from "./events.js";
import {
  createInvite,
  createRoom,
  getRoomState,
  joinRoom,
  revokeInvite,
  transferCoordinator,
} from "./rooms.js";
import {
  listHandoffs,
  reviewHandoff,
  submitHandoff,
} from "./handoffs.js";
import {
  listRequests,
  requestPlan,
  respondToRequest,
  sendMessage,
} from "./messaging.js";
import { heartbeatSession, revokeSession } from "./sessions.js";
import {
  assignTask,
  listTasks,
  proposeTask,
  updateTask,
} from "./tasks.js";
import type { WorkspaceDirectory } from "./workspace.js";
import type {
  AuthenticatedActor,
  AssignTaskInput,
  CreateInviteInput,
  CreateInviteResult,
  CreateRoomInput,
  CreateRoomResult,
  GetUpdatesInput,
  HandoffView,
  HeartbeatResult,
  InviteView,
  JoinRoomInput,
  JoinRoomResult,
  LeaveResult,
  ListHandoffsOptions,
  ListRequestsOptions,
  ListTasksOptions,
  ProposeTaskInput,
  RequestPlanInput,
  RequestResult,
  RequestView,
  RespondToRequestInput,
  ReviewHandoffInput,
  RoomStateView,
  SendMessageInput,
  SendMessageResult,
  SubmitHandoffInput,
  TaskUpdateResult,
  TaskView,
  TransferCoordinatorResult,
  UpdateTaskInput,
  UpdatesPage,
} from "./types.js";

/** Valores provisorios; duracoes definitivas continuam abertas no plano. */
export const DEFAULT_SESSION_TTL_MS = 15 * 60_000;
export const DEFAULT_INVITE_TTL_MS = 24 * 60 * 60_000;

export interface CollaborationServiceOptions {
  readonly db: DatabaseConnection;
  readonly workspaceDirectory: WorkspaceDirectory;
  /** Relogio injetavel; testes usam para expirar sessoes/convites. */
  readonly now?: () => Date;
  readonly sessionTtlMs?: number;
  readonly inviteTtlMs?: number;
  /**
   * Principal autenticado no transporte. OBRIGATORIO: as tools derivam daqui,
   * nunca de argumentos do modelo. Em producao vem do `ToolContext` da sessao;
   * em testes de servico e injetado explicitamente pela fixture.
   */
  readonly principalId: PrincipalId;
}

/**
 * Superficie programatica do modulo. Os metodos recebem o ator JA
 * autenticado, exceto create/join/authenticate/heartbeat/leave, que lidam com
 * tokens. As ferramentas MCP autenticam uma unica vez por chamada.
 */
export interface CollaborationService {
  readonly runtime: CollaborationRuntime;
  authenticate(sessionToken: string): AuthenticatedActor;
  createRoom(input: CreateRoomInput): Promise<CreateRoomResult>;
  createInvite(actor: AuthenticatedActor, input: CreateInviteInput): CreateInviteResult;
  joinRoom(input: JoinRoomInput): JoinRoomResult;
  revokeInvite(actor: AuthenticatedActor, inviteId: string): InviteView;
  transferCoordinator(
    actor: AuthenticatedActor,
    targetAgentId: string,
  ): TransferCoordinatorResult;
  heartbeat(sessionToken: string): HeartbeatResult;
  leave(sessionToken: string): LeaveResult;
  getRoomState(actor: AuthenticatedActor): RoomStateView;
  getUpdates(actor: AuthenticatedActor, input?: GetUpdatesInput): UpdatesPage;
  sendMessage(actor: AuthenticatedActor, input: SendMessageInput): SendMessageResult;
  requestPlan(actor: AuthenticatedActor, input: RequestPlanInput): RequestResult;
  respondToRequest(actor: AuthenticatedActor, input: RespondToRequestInput): RequestResult;
  listRequests(actor: AuthenticatedActor, options?: ListRequestsOptions): readonly RequestView[];
  proposeTask(actor: AuthenticatedActor, input: ProposeTaskInput): TaskView;
  assignTask(actor: AuthenticatedActor, input: AssignTaskInput): TaskView;
  updateTask(actor: AuthenticatedActor, input: UpdateTaskInput): TaskUpdateResult;
  listTasks(actor: AuthenticatedActor, options?: ListTasksOptions): readonly TaskView[];
  submitHandoff(actor: AuthenticatedActor, input: SubmitHandoffInput): HandoffView;
  reviewHandoff(actor: AuthenticatedActor, input: ReviewHandoffInput): HandoffView;
  listHandoffs(
    actor: AuthenticatedActor,
    options?: ListHandoffsOptions,
  ): readonly HandoffView[];
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} deve ser um inteiro positivo de milissegundos.`);
  }
  return value;
}

export function createCollaborationService(
  options: CollaborationServiceOptions,
): CollaborationService {
  const now = options.now ?? ((): Date => new Date());
  const runtime: CollaborationRuntime = {
    db: options.db,
    workspaceDirectory: options.workspaceDirectory,
    now,
    sessionTtlMs: positiveInteger(
      options.sessionTtlMs,
      DEFAULT_SESSION_TTL_MS,
      "sessionTtlMs",
    ),
    inviteTtlMs: positiveInteger(options.inviteTtlMs, DEFAULT_INVITE_TTL_MS, "inviteTtlMs"),
    principalId: options.principalId,
  };
  const principalId = options.principalId;

  return {
    runtime,
    authenticate: (sessionToken) =>
      authenticateCollaborationSession(runtime.db, sessionToken, {
        now: runtime.now,
        principalId,
      }),
    createRoom: (input) => createRoom(runtime, { ...input, principalId }),
    createInvite: (actor, input) => createInvite(runtime, actor, input),
    joinRoom: (input) => joinRoom(runtime, { ...input, principalId }),
    revokeInvite: (actor, inviteId) => revokeInvite(runtime, actor, inviteId),
    transferCoordinator: (actor, targetAgentId) =>
      transferCoordinator(runtime, actor, targetAgentId),
    heartbeat: (sessionToken) =>
      heartbeatSession(runtime.db, sessionToken, {
        now: runtime.now,
        sessionTtlMs: runtime.sessionTtlMs,
        principalId,
      }),
    leave: (sessionToken) =>
      revokeSession(runtime.db, sessionToken, { now: runtime.now, principalId }),
    getRoomState: (actor) => getRoomState(runtime, actor),
    getUpdates: (actor, input = {}) =>
      readAuthorizedUpdates(runtime.db, actor.room.id, actor.agent.id, input),
    sendMessage: (actor, input) => sendMessage(runtime, actor, input),
    requestPlan: (actor, input) => requestPlan(runtime, actor, input),
    respondToRequest: (actor, input) => respondToRequest(runtime, actor, input),
    listRequests: (actor, listOptions = {}) => listRequests(runtime, actor, listOptions),
    proposeTask: (actor, input) => proposeTask(runtime, actor, input),
    assignTask: (actor, input) => assignTask(runtime, actor, input),
    updateTask: (actor, input) => updateTask(runtime, actor, input),
    listTasks: (actor, listOptions = {}) => listTasks(runtime, actor, listOptions),
    submitHandoff: (actor, input) => submitHandoff(runtime, actor, input),
    reviewHandoff: (actor, input) => reviewHandoff(runtime, actor, input),
    listHandoffs: (actor, listOptions = {}) => listHandoffs(runtime, actor, listOptions),
  };
}
