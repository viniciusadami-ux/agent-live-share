import * as z from "zod/v4";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toErrorPayload } from "../contracts/index.js";
import {
  authenticateCollaborationSession,
  safeRecordAudit,
  type AuthenticatedActor,
} from "../collaboration/index.js";
import type { WorkspaceRuntime } from "./runtime.js";
import { resolveAuthorizedRoot } from "./paths.js";

/**
 * Suporte compartilhado pelas tools de workspace/locking.
 *
 * TODA tool autentica a sessao EM CADA CHAMADA via `authenticateCollaborationSession`
 * (somente o token identifica o ator). Sala, agente, papeis e workspace vem do
 * banco; o chamador nunca prova identidade com agentId/roomId. Em seguida
 * `resolveAuthorizedRoot` revalida a autorizacao do principal de transporte
 * sobre `actor.room.workspaceId` (fail-closed, lista allowedPrincipals).
 * Auditoria de sucessos e negacoes usa `safeRecordAudit` sem tokens/root/conteudo.
 */

export type DataRecord = Record<string, unknown>;

export function successOutputSchema(tool: string): {
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

export function success(tool: string, data: DataRecord): CallToolResult {
  const envelope = { ok: true as const, tool, data };
  return {
    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope,
  };
}

export function failure(tool: string, error: unknown): CallToolResult {
  const payload = toErrorPayload(error);
  const envelope = { ok: false as const, tool, error: payload };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope,
  };
}

export const tokenSchema = z.string().min(1).max(512);
export const pathSchema = z.string().min(1).max(500);
export const lockIdSchema = z.string().min(1).max(120);
export const intentSchema = z.string().min(1).max(500);

const DENIAL_CODES: readonly string[] = [
  "FORBIDDEN",
  "SESSION_INACTIVE",
  "PATH_OUTSIDE_WORKSPACE",
  "LOCK_NOT_HELD",
  "LOCK_ALREADY_HELD",
  "LOCK_EXPIRED",
  "HASH_MISMATCH",
  "VERSION_MISMATCH",
  "PATCH_NOT_APPLICABLE",
  "CHECKPOINT_IN_PROGRESS",
  "CONFLICT",
  "NOT_FOUND",
];

function audit(
  runtime: WorkspaceRuntime,
  tool: string,
  outcome: "ok" | "denied" | "failed",
  actor: AuthenticatedActor | undefined,
  error?: unknown,
): void {
  safeRecordAudit(runtime.db, {
    operation: tool,
    outcome,
    ...(actor === undefined
      ? {}
      : {
          roomId: actor.room.id,
          actorAgentId: actor.agent.id,
          sessionId: actor.session.id,
        }),
    ...(error === undefined ? {} : { errorCode: toErrorPayload(error).code }),
  });
}

export interface WithActorOptions {
  /** false = nao auditar (leitura pura e nao sensivel). */
  readonly audit?: boolean;
}

/**
 * Fluxo padrao: autenticar -> executar -> auditar -> envelope. O token nunca
 * entra na auditoria nem no structuredContent (exceto em create/join da
 * colaboracao, que nao passam por aqui).
 */
export async function withActor(
  runtime: WorkspaceRuntime,
  tool: string,
  token: string,
  handler: (actor: AuthenticatedActor) => DataRecord | Promise<DataRecord>,
  options: WithActorOptions = {},
): Promise<CallToolResult> {
  const shouldAudit = options.audit !== false;
  let actor: AuthenticatedActor | undefined;
  try {
    actor = authenticateCollaborationSession(runtime.db, token, {
      now: runtime.now,
      principalId: runtime.principalId,
    });
    // AUTORIZACAO POR WORKSPACE: TODA tool de workspace/locking/checkpoint
    // reconfirma, a cada chamada, que o principal autenticado ainda consta na
    // lista allowedPrincipals do workspace da sala (fail-closed). A politica e
    // compartilhada e revalidavel: remocao bloqueia a PROXIMA chamada.
    resolveAuthorizedRoot(
      runtime.catalog,
      actor.room.workspaceId,
      runtime.principalId,
    );
    const data = await handler(actor);
    if (shouldAudit) audit(runtime, tool, "ok", actor);
    return success(tool, data);
  } catch (error) {
    if (shouldAudit) {
      const code = toErrorPayload(error).code;
      audit(runtime, tool, DENIAL_CODES.includes(code) ? "denied" : "failed", actor, error);
    }
    return failure(tool, error);
  }
}
