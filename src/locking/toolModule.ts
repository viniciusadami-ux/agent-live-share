import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolModule } from "../server/composition.js";
import type { WorkspaceRuntime } from "../workspace/runtime.js";
import {
  intentSchema,
  lockIdSchema,
  pathSchema,
  successOutputSchema,
  tokenSchema,
  withActor,
} from "../workspace/toolSupport.js";
import {
  acquireLock,
  lockList,
  lockStatus,
  releaseLock,
  renewLock,
} from "./locks.js";

export const LOCKING_TOOL_NAMES = [
  "collab_lock_acquire",
  "collab_lock_renew",
  "collab_lock_release",
  "collab_lock_status",
  "collab_lock_list",
] as const;

const annotations = (readOnly: boolean, destructive: boolean) => ({
  readOnlyHint: readOnly,
  destructiveHint: destructive,
  idempotentHint: readOnly,
  openWorldHint: false,
});

/**
 * Locks exclusivos por arquivo (GLOBAIS no workspace, nao por sala).
 * Toda mutacao de workspace valida o lockId pelo servico `assertUsableLock`.
 */
export function lockingToolModule(runtime: WorkspaceRuntime): ToolModule {
  return (server: McpServer): void => {
    server.registerTool(
      "collab_lock_acquire",
      {
        title: "Adquirir lock exclusivo",
        description:
          "Reserva um arquivo para escrita (lock exclusivo GLOBAL no workspace). " +
          "Conflito devolve dono/intencao/expiracao e orienta negociacao via collab_send_message. " +
          "Reaquisicao pelo MESMO dono = renovacao segura (reacquired:true). " +
          "taskId opcional precisa pertencer a sala autenticada. Lock expira por TTL; renove com collab_lock_renew.",
        inputSchema: {
          token: tokenSchema,
          path: pathSchema,
          intent: intentSchema,
          taskId: z.string().min(1).max(100).optional(),
        },
        outputSchema: successOutputSchema("collab_lock_acquire"),
        annotations: annotations(false, false),
      },
      (args): Promise<CallToolResult> =>
        withActor(runtime, "collab_lock_acquire", args.token, (actor) => ({
          ...acquireLock(runtime, actor, {
            path: args.path,
            intent: args.intent,
            taskId: args.taskId,
          }),
        })),
    );

    server.registerTool(
      "collab_lock_renew",
      {
        title: "Renovar lock (heartbeat)",
        description:
          "Heartbeat do lock: somente o DONO autenticado renova o TTL. Nao ha heartbeat automatico na autenticacao de colaboracao.",
        inputSchema: { token: tokenSchema, lockId: lockIdSchema },
        outputSchema: successOutputSchema("collab_lock_renew"),
        annotations: annotations(false, false),
      },
      (args): Promise<CallToolResult> =>
        withActor(runtime, "collab_lock_renew", args.token, (actor) => ({
          lock: renewLock(runtime, actor, { lockId: args.lockId }),
        })),
    );

    server.registerTool(
      "collab_lock_release",
      {
        title: "Liberar lock",
        description:
          "Libera o lock. Somente o DONO autenticado pode liberar (coordinator NAO rouba lock). Idempotente se ja liberado.",
        inputSchema: { token: tokenSchema, lockId: lockIdSchema },
        outputSchema: successOutputSchema("collab_lock_release"),
        annotations: annotations(false, true),
      },
      (args): Promise<CallToolResult> =>
        withActor(runtime, "collab_lock_release", args.token, (actor) => ({
          lock: releaseLock(runtime, actor, { lockId: args.lockId }),
        })),
    );

    server.registerTool(
      "collab_lock_status",
      {
        title: "Consultar conflito de lock",
        description:
          "Mostra o lock ATIVO de um caminho (dono, intencao, expiracao) e se pertence ao chamador. " +
          "Util para negociar antes de pedir o lock.",
        inputSchema: { token: tokenSchema, path: pathSchema },
        outputSchema: successOutputSchema("collab_lock_status"),
        annotations: annotations(true, false),
      },
      (args): Promise<CallToolResult> =>
        withActor(
          runtime,
          "collab_lock_status",
          args.token,
          (actor) => ({ ...lockStatus(runtime, actor, { path: args.path }) }),
          { audit: false },
        ),
    );

    server.registerTool(
      "collab_lock_list",
      {
        title: "Listar locks ativos",
        description:
          "Lista todos os locks ATIVOS no workspace da sala (inclusive de OUTRAS salas no mesmo workspace). " +
          "Aplica expiracao lazy antes de listar.",
        inputSchema: { token: tokenSchema },
        outputSchema: successOutputSchema("collab_lock_list"),
        annotations: annotations(true, false),
      },
      (args): Promise<CallToolResult> =>
        withActor(
          runtime,
          "collab_lock_list",
          args.token,
          (actor) => ({ ...lockList(runtime, actor) }),
          { audit: false },
        ),
    );
  };
}
