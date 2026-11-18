import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toErrorPayload } from "../contracts/index.js";
import { safeRecordAudit } from "./events.js";
import type { CollaborationService } from "./service.js";
import type { AuthenticatedActor } from "./types.js";

/**
 * Ferramentas MCP de colaboracao (prefixo `collab_`).
 *
 * Toda resposta de sucesso segue o envelope `{ ok: true, tool, data }` e e
 * declarada no `outputSchema`; erros usam `isError: true` com
 * `{ ok: false, tool, error: { code, message, hint } }`. Nenhum token,
 * convite ou hash aparece em logs, eventos ou auditoria.
 *
 * Ferramentas com token autenticam UMA vez e derivam sala/agente/papeis da
 * sessao; `agentId`/`roomId` nunca sao aceitos do chamador para autorizacao.
 */

type DataRecord = Record<string, unknown>;

function successOutputSchema(tool: string): {
  ok: z.ZodLiteral<true>;
  tool: z.ZodLiteral<string>;
  data: z.ZodRecord<z.ZodString, z.ZodUnknown>;
} {
  return {
    ok: z.literal(true),
    tool: z.literal(tool),
    data: z.record(z.string(), z.unknown()),
  };
}

function success(tool: string, data: DataRecord): CallToolResult {
  const envelope = { ok: true as const, tool, data };
  return {
    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope,
  };
}

function failure(tool: string, error: unknown): CallToolResult {
  const payload = toErrorPayload(error);
  const envelope = { ok: false as const, tool, error: payload };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope,
  };
}

function principal(actor: AuthenticatedActor) {
  return {
    roomId: actor.room.id,
    actorAgentId: actor.agent.id,
    sessionId: actor.session.id,
  };
}

function auditOutcome(error: unknown): "denied" | "failed" {
  const payload = toErrorPayload(error);
  return payload.code === "FORBIDDEN" || payload.code === "SESSION_INACTIVE"
    ? "denied"
    : "failed";
}

function recordFailure(
  service: CollaborationService,
  tool: string,
  error: unknown,
  actor?: AuthenticatedActor,
): void {
  safeRecordAudit(service.runtime.db, {
    operation: tool,
    outcome: auditOutcome(error),
    errorCode: toErrorPayload(error).code,
    ...(actor === undefined ? {} : principal(actor)),
  });
}

/**
 * Fluxo padrao das ferramentas autenticadas: autenticar -> executar ->
 * auditar (quando mutavel) -> envelope. O token nunca entra na auditoria.
 */
async function withAuthenticatedActor(
  service: CollaborationService,
  tool: string,
  token: string,
  handler: (actor: AuthenticatedActor) => DataRecord | Promise<DataRecord>,
  options: { readonly audit?: boolean } = {},
): Promise<CallToolResult> {
  let actor: AuthenticatedActor | undefined;
  try {
    actor = service.authenticate(token);
    const data = await handler(actor);
    if (options.audit !== false) {
      safeRecordAudit(service.runtime.db, {
        operation: tool,
        outcome: "ok",
        ...principal(actor),
      });
    }
    return success(tool, data);
  } catch (error) {
    if (options.audit !== false || actor === undefined) {
      recordFailure(service, tool, error, actor);
    }
    return failure(tool, error);
  }
}

const tokenSchema = z.string().min(1).max(512);
const displayNameSchema = z.string().min(1).max(80);
const clientKindSchema = z.string().min(1).max(60).optional();
const taskStatusSchema = z.enum([
  "proposed",
  "accepted",
  "in_progress",
  "blocked",
  "completed",
  "cancelled",
]);
const requestStatusSchema = z.enum(["open", "answered", "closed"]);

export const COLLABORATION_TOOL_NAMES = [
  "collab_create_room",
  "collab_create_invite",
  "collab_join_room",
  "collab_heartbeat",
  "collab_leave",
  "collab_room_state",
  "collab_transfer_coordinator",
  "collab_revoke_invite",
  "collab_send_message",
  "collab_get_updates",
  "collab_request_plan",
  "collab_respond_to_request",
  "collab_list_requests",
  "collab_propose_task",
  "collab_assign_task",
  "collab_update_task",
  "collab_list_tasks",
  "collab_submit_handoff",
  "collab_review_handoff",
  "collab_list_handoffs",
] as const;

export type CollaborationToolName = (typeof COLLABORATION_TOOL_NAMES)[number];

/**
 * Registra as ferramentas no `McpServer` da sessao HTTP. O servico e stateless
 * (todo estado fica no SQLite compartilhado), portanto pode ser recriado por
 * sessao de transporte sem perder dados.
 */
export function registerCollaborationTools(
  server: McpServer,
  service: CollaborationService,
): void {
  server.registerTool(
    "collab_create_room",
    {
      title: "Criar sala de colaboracao",
      description:
        "Cria uma sala vinculada a um workspaceId OPERACIONAL do catalogo do servidor " +
        "e registra o agente chamador como coordinator + worker. Retorna um sessionToken " +
        "secreto UMA vez (somente o hash e persistido); guarde-o para as demais chamadas. " +
        "Caminhos do host nao sao aceitos.",
      inputSchema: {
        displayName: displayNameSchema,
        clientKind: clientKindSchema,
        roomName: z.string().min(1).max(120),
        workspaceId: z.string().min(1).max(200),
      },
      outputSchema: successOutputSchema("collab_create_room"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args): Promise<CallToolResult> => {
      const tool = "collab_create_room";
      try {
        const result = await service.createRoom({
          displayName: args.displayName,
          clientKind: args.clientKind,
          roomName: args.roomName,
          workspaceId: args.workspaceId,
        });
        safeRecordAudit(service.runtime.db, {
          operation: tool,
          outcome: "ok",
          roomId: result.room.id,
          actorAgentId: result.agent.id,
          sessionId: result.session.id,
        });
        return success(tool, {
          agent: result.agent,
          room: result.room,
          participant: result.participant,
          session: result.session,
          sessionToken: result.sessionToken,
          notice:
            "Guarde sessionToken agora: ele e secreto, nao aparece em eventos/auditoria e nao sera exibido novamente.",
        });
      } catch (error) {
        recordFailure(service, tool, error);
        return failure(tool, error);
      }
    },
  );

  server.registerTool(
    "collab_create_invite",
    {
      title: "Criar convite da sala",
      description:
        "Coordinator cria um convite de uso controlado. Ingresso normal e worker; " +
        "reviewer e opcional. O inviteToken e retornado UMA vez e somente o hash e " +
        "persistido; nunca e registrado em eventos/auditoria.",
      inputSchema: {
        token: tokenSchema,
        reviewer: z.boolean().optional(),
        expiresInMinutes: z.number().int().min(1).max(43_200).optional(),
        maxUses: z.number().int().min(1).max(100).optional(),
      },
      outputSchema: successOutputSchema("collab_create_invite"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args): Promise<CallToolResult> =>
      withAuthenticatedActor(service, "collab_create_invite", args.token, (actor) => {
        const result = service.createInvite(actor, {
          reviewer: args.reviewer,
          expiresInMinutes: args.expiresInMinutes,
          maxUses: args.maxUses,
        });
        return {
          invite: result.invite,
          inviteToken: result.inviteToken,
          notice:
            "Entregue inviteToken por um canal privado. Ele e secreto, nao aparece em eventos/auditoria e nao sera exibido novamente.",
        };
      }),
  );

  server.registerTool(
    "collab_join_room",
    {
      title: "Entrar na sala com convite",
      description:
        "Ingressa na sala usando um inviteToken valido. Registra displayName/clientKind, " +
        "cria o agente e uma sessao autenticada. O papel e worker (reviewer quando o " +
        "convite permitir); coordinator nunca e concedido por convite. Retorna sessionToken " +
        "UMA vez.",
      inputSchema: {
        inviteToken: z.string().min(1).max(512),
        displayName: displayNameSchema,
        clientKind: clientKindSchema,
      },
      outputSchema: successOutputSchema("collab_join_room"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args): CallToolResult => {
      const tool = "collab_join_room";
      try {
        const result = service.joinRoom({
          inviteToken: args.inviteToken,
          displayName: args.displayName,
          clientKind: args.clientKind,
        });
        safeRecordAudit(service.runtime.db, {
          operation: tool,
          outcome: "ok",
          roomId: result.room.id,
          actorAgentId: result.agent.id,
          sessionId: result.session.id,
        });
        return success(tool, {
          agent: result.agent,
          room: result.room,
          participant: result.participant,
          session: result.session,
          inviteId: result.inviteId,
          sessionToken: result.sessionToken,
          notice:
            "Guarde sessionToken agora: ele e secreto, nao aparece em eventos/auditoria e nao sera exibido novamente.",
        });
      } catch (error) {
        recordFailure(service, tool, error);
        return failure(tool, error);
      }
    },
  );

  server.registerTool(
    "collab_heartbeat",
    {
      title: "Renovar heartbeat da sessao",
      description:
        "Renova atomicamente a expiracao da sessao atual. Nao registra evento (evita ruido " +
        "de polling); se a sessao ja expirou ou foi revogada, retorna SESSION_INACTIVE.",
      inputSchema: {
        token: tokenSchema,
      },
      outputSchema: successOutputSchema("collab_heartbeat"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args): CallToolResult => {
      try {
        return success("collab_heartbeat", { ...service.heartbeat(args.token) });
      } catch (error) {
        recordFailure(service, "collab_heartbeat", error);
        return failure("collab_heartbeat", error);
      }
    },
  );

  server.registerTool(
    "collab_leave",
    {
      title: "Sair da sessao",
      description:
        "Revoga a sessao atual (logout). A associacao historica com a sala permanece; " +
        "um novo ingresso exige novo convite. Locks futuros deverao expirar por heartbeat.",
      inputSchema: {
        token: tokenSchema,
      },
      outputSchema: successOutputSchema("collab_leave"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args): Promise<CallToolResult> =>
      withAuthenticatedActor(service, "collab_leave", args.token, (actor) => {
        const result = service.leave(args.token);
        return {
          ...result,
          ...(actor.isCoordinator
            ? {
                warning:
                  "Este agente era o coordinator. A sala continua apontando para ele; " +
                  "transfira a coordenacao antes de sair para manter a sala operavel.",
              }
            : {}),
        };
      }),
  );

  server.registerTool(
    "collab_room_state",
    {
      title: "Estado da sala",
      description:
        "Lista participantes, papeis, coordinator, contagem de sessoes ativas e resumo de " +
        "tarefas. Nunca retorna tokens, convites ou hashes.",
      inputSchema: {
        token: tokenSchema,
      },
      outputSchema: successOutputSchema("collab_room_state"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args): Promise<CallToolResult> =>
      withAuthenticatedActor(
        service,
        "collab_room_state",
        args.token,
        (actor) => ({ ...service.getRoomState(actor) }),
        { audit: false },
      ),
  );

  server.registerTool(
    "collab_transfer_coordinator",
    {
      title: "Transferir coordenacao",
      description:
        "Operacao EXPLICITA do coordinator atual para transferir o papel a outro participante " +
        "ativo. Nao existe segunda coordenacao concorrente: a troca e atomica e a sala passa " +
        "a apontar para o novo coordinator.",
      inputSchema: {
        token: tokenSchema,
        targetAgentId: z.string().min(1).max(100),
      },
      outputSchema: successOutputSchema("collab_transfer_coordinator"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args): Promise<CallToolResult> =>
      withAuthenticatedActor(
        service,
        "collab_transfer_coordinator",
        args.token,
        (actor) => ({ ...service.transferCoordinator(actor, args.targetAgentId) }),
      ),
  );

  server.registerTool(
    "collab_revoke_invite",
    {
      title: "Revogar convite",
      description:
        "Coordinator revoga um convite da propria sala. Convites revogados nao podem mais " +
        "ser usados, mesmo antes de expirar.",
      inputSchema: {
        token: tokenSchema,
        inviteId: z.string().min(1).max(100),
      },
      outputSchema: successOutputSchema("collab_revoke_invite"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args): Promise<CallToolResult> =>
      withAuthenticatedActor(service, "collab_revoke_invite", args.token, (actor) => ({
        invite: service.revokeInvite(actor, args.inviteId),
      })),
  );

  server.registerTool(
    "collab_send_message",
    {
      title: "Enviar mensagem",
      description:
        "Envia mensagem para a sala (omita toAgentId) ou mensagem direta a um participante " +
        "ativo. Mensagens diretas so aparecem em get_updates do remetente e do destinatario.",
      inputSchema: {
        token: tokenSchema,
        body: z.string().min(1).max(8000),
        toAgentId: z.string().min(1).max(100).optional(),
        kind: z.enum(["chat", "decision"]).optional(),
      },
      outputSchema: successOutputSchema("collab_send_message"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args): Promise<CallToolResult> =>
      withAuthenticatedActor(service, "collab_send_message", args.token, (actor) => ({
        ...service.sendMessage(actor, {
          body: args.body,
          toAgentId: args.toAgentId,
          kind: args.kind,
        }),
      })),
  );

  server.registerTool(
    "collab_get_updates",
    {
      title: "Consultar atualizacoes",
      description:
        "Polling NAO BLOQUEANTE por cursor monotonico. Retorna somente eventos autorizados " +
        "para o ator: broadcast da sala, mensagens diretas destinadas a ele e eventos " +
        "proprios. Mensagens diretas de terceiros nunca sao retornadas.",
      inputSchema: {
        token: tokenSchema,
        cursor: z.string().regex(/^\d+$/).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      outputSchema: successOutputSchema("collab_get_updates"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args): Promise<CallToolResult> =>
      withAuthenticatedActor(
        service,
        "collab_get_updates",
        args.token,
        (actor) => ({ ...service.getUpdates(actor, { cursor: args.cursor, limit: args.limit }) }),
        { audit: false },
      ),
  );

  server.registerTool(
    "collab_request_plan",
    {
      title: "Solicitar plano ao coordinator",
      description:
        "Worker registra uma solicitacao de plano enderecada AO COORDINATOR ATUAL da sala " +
        "(derivado do servidor, nunca informado pelo chamador) e cria a mensagem correlata. " +
        "O coordinator responde com collab_respond_to_request.",
      inputSchema: {
        token: tokenSchema,
        subject: z.string().min(1).max(200),
        details: z.string().max(8000).optional(),
      },
      outputSchema: successOutputSchema("collab_request_plan"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args): Promise<CallToolResult> =>
      withAuthenticatedActor(service, "collab_request_plan", args.token, (actor) => ({
        ...service.requestPlan(actor, { subject: args.subject, details: args.details }),
      })),
  );

  server.registerTool(
    "collab_respond_to_request",
    {
      title: "Responder solicitacao",
      description:
        "Responde a uma solicitacao aberta. Somente o destinatario original ou o coordinator " +
        "atual da sala pode responder; a resposta e correlacionada a mensagem original.",
      inputSchema: {
        token: tokenSchema,
        requestId: z.string().min(1).max(100),
        body: z.string().min(1).max(8000),
      },
      outputSchema: successOutputSchema("collab_respond_to_request"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args): Promise<CallToolResult> =>
      withAuthenticatedActor(service, "collab_respond_to_request", args.token, (actor) => ({
        ...service.respondToRequest(actor, {
          requestId: args.requestId,
          body: args.body,
        }),
      })),
  );

  server.registerTool(
    "collab_list_requests",
    {
      title: "Listar solicitacoes",
      description:
        "Coordinator ve todas as solicitacoes da sala; demais agentes veem apenas as que " +
        "enviaram ou receberam.",
      inputSchema: {
        token: tokenSchema,
        status: requestStatusSchema.optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      outputSchema: successOutputSchema("collab_list_requests"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args): Promise<CallToolResult> =>
      withAuthenticatedActor(
        service,
        "collab_list_requests",
        args.token,
        (actor) => ({
          requests: service.listRequests(actor, {
            status: args.status,
            limit: args.limit,
          }),
        }),
        { audit: false },
      ),
  );

  server.registerTool(
    "collab_propose_task",
    {
      title: "Propor tarefa",
      description:
        "Coordinator propoe uma tarefa, opcionalmente ja atribuida, com dependencias basicas " +
        "(dependsOn). A tarefa nasce em proposed e precisa ser aceita pelo agente atribuido.",
      inputSchema: {
        token: tokenSchema,
        title: z.string().min(1).max(200),
        description: z.string().max(8000).optional(),
        assigneeAgentId: z.string().min(1).max(100).optional(),
        dependsOn: z.array(z.string().min(1).max(100)).max(20).optional(),
      },
      outputSchema: successOutputSchema("collab_propose_task"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args): Promise<CallToolResult> =>
      withAuthenticatedActor(service, "collab_propose_task", args.token, (actor) => ({
        task: service.proposeTask(actor, {
          title: args.title,
          description: args.description,
          assigneeAgentId: args.assigneeAgentId,
          dependsOn: args.dependsOn,
        }),
      })),
  );

  server.registerTool(
    "collab_assign_task",
    {
      title: "Atribuir tarefa",
      description:
        "Coordinator atribui ou reatribui uma tarefa nao terminal a um participante ativo. " +
        "Reatribuicao volta a tarefa para proposed e exige novo aceite.",
      inputSchema: {
        token: tokenSchema,
        taskId: z.string().min(1).max(100),
        assigneeAgentId: z.string().min(1).max(100),
      },
      outputSchema: successOutputSchema("collab_assign_task"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args): Promise<CallToolResult> =>
      withAuthenticatedActor(service, "collab_assign_task", args.token, (actor) => ({
        task: service.assignTask(actor, {
          taskId: args.taskId,
          assigneeAgentId: args.assigneeAgentId,
        }),
      })),
  );

  server.registerTool(
    "collab_update_task",
    {
      title: "Atualizar tarefa",
      description:
        "Atualiza a propria tarefa: accept, start, block, unblock, progress, complete ou cancel. " +
        "Acoes de execucao exigem ser o agente atribuido; cancel exige coordinator. complete " +
        "exige handoff suficiente (objetivo real + resultado de teste) do mesmo autor.",
      inputSchema: {
        token: tokenSchema,
        taskId: z.string().min(1).max(100),
        action: z.enum([
          "accept",
          "start",
          "block",
          "unblock",
          "progress",
          "complete",
          "cancel",
        ]),
        note: z.string().max(4000).optional(),
        reason: z.string().max(2000).optional(),
      },
      outputSchema: successOutputSchema("collab_update_task"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args): Promise<CallToolResult> =>
      withAuthenticatedActor(service, "collab_update_task", args.token, (actor) => ({
        ...service.updateTask(actor, {
          taskId: args.taskId,
          action: args.action,
          note: args.note,
          reason: args.reason,
        }),
      })),
  );

  server.registerTool(
    "collab_list_tasks",
    {
      title: "Listar tarefas",
      description:
        "Lista tarefas da sala com status, responsavel, dependencias e resumo de handoffs. " +
        "Todos os participantes da sala podem acompanhar o quadro.",
      inputSchema: {
        token: tokenSchema,
        status: taskStatusSchema.optional(),
        assigneeAgentId: z.string().min(1).max(100).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      outputSchema: successOutputSchema("collab_list_tasks"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args): Promise<CallToolResult> =>
      withAuthenticatedActor(
        service,
        "collab_list_tasks",
        args.token,
        (actor) => ({
          tasks: service.listTasks(actor, {
            status: args.status,
            assigneeAgentId: args.assigneeAgentId,
            limit: args.limit,
          }),
        }),
        { audit: false },
      ),
  );

  server.registerTool(
    "collab_submit_handoff",
    {
      title: "Enviar handoff",
      description:
        "Agente atribuido registra handoff persistente da tarefa: objetivo, arquivos " +
        "(metadados, sem acesso ao filesystem), testes/resultados, decisoes, problemas, " +
        "reutilizacao, pendencias e proximo passo. requestReview abre revisao para reviewer.",
      inputSchema: {
        token: tokenSchema,
        taskId: z.string().min(1).max(100),
        objective: z.string().min(1).max(4000),
        changes: z
          .array(
            z.object({
              path: z.string().min(1).max(400),
              kind: z.enum(["created", "modified", "deleted"]),
            }),
          )
          .max(100)
          .optional(),
        tests: z
          .array(
            z.object({
              name: z.string().min(1).max(200),
              passed: z.boolean(),
            }),
          )
          .max(100)
          .optional(),
        decisions: z.array(z.string().min(1).max(2000)).max(100).optional(),
        knownIssues: z.array(z.string().min(1).max(2000)).max(100).optional(),
        reusable: z.array(z.string().min(1).max(2000)).max(100).optional(),
        pending: z.array(z.string().min(1).max(2000)).max(100).optional(),
        nextStep: z.string().max(2000).optional(),
        requestReview: z.boolean().optional(),
      },
      outputSchema: successOutputSchema("collab_submit_handoff"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args): Promise<CallToolResult> =>
      withAuthenticatedActor(service, "collab_submit_handoff", args.token, (actor) => ({
        handoff: service.submitHandoff(actor, {
          taskId: args.taskId,
          objective: args.objective,
          changes: args.changes,
          tests: args.tests,
          decisions: args.decisions,
          knownIssues: args.knownIssues,
          reusable: args.reusable,
          pending: args.pending,
          nextStep: args.nextStep,
          requestReview: args.requestReview,
        }),
      })),
  );

  server.registerTool(
    "collab_review_handoff",
    {
      title: "Revisar handoff",
      description:
        "Reviewer (ou coordinator) revisa um handoff com requestReview pendente. " +
        "changes_requested exige notas; o autor nao pode revisar o proprio handoff.",
      inputSchema: {
        token: tokenSchema,
        handoffId: z.string().min(1).max(100),
        decision: z.enum(["approved", "changes_requested"]),
        notes: z.string().max(4000).optional(),
      },
      outputSchema: successOutputSchema("collab_review_handoff"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args): Promise<CallToolResult> =>
      withAuthenticatedActor(service, "collab_review_handoff", args.token, (actor) => ({
        handoff: service.reviewHandoff(actor, {
          handoffId: args.handoffId,
          decision: args.decision,
          notes: args.notes,
        }),
      })),
  );

  server.registerTool(
    "collab_list_handoffs",
    {
      title: "Listar handoffs",
      description:
        "Lista handoffs da sala, opcionalmente por tarefa. Inclui autoria, mudancas " +
        "declaradas, testes, problemas, pendencias e estado de revisao.",
      inputSchema: {
        token: tokenSchema,
        taskId: z.string().min(1).max(100).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      outputSchema: successOutputSchema("collab_list_handoffs"),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args): Promise<CallToolResult> =>
      withAuthenticatedActor(
        service,
        "collab_list_handoffs",
        args.token,
        (actor) => ({
          handoffs: service.listHandoffs(actor, {
            taskId: args.taskId,
            limit: args.limit,
          }),
        }),
        { audit: false },
      ),
  );
}
