import type { AgentId, IsoDateTime } from "./ids.js";

/** Papeis previstos pelo planejamento. Um agente pode acumular mais de um. */
export type Role = "coordinator" | "worker" | "reviewer";

export const ROLES: readonly Role[] = ["coordinator", "worker", "reviewer"] as const;

export function isRole(value: unknown): value is Role {
  return value === "coordinator" || value === "worker" || value === "reviewer";
}

/**
 * Associacao de papeis a um participante da sala.
 * O coordinator nao e fixo por cliente: e configurado por sala.
 */
export interface RoleAssignment {
  readonly agentId: AgentId;
  readonly roles: readonly Role[];
  readonly assignedAt: IsoDateTime;
}
