import { randomUUID } from "node:crypto";

/**
 * IDs opacos do modulo. Prefixos tornam logs e mensagens de erro legiveis sem
 * depender de formato especifico de fornecedor.
 */
const PREFIXES = {
  agent: "agent",
  room: "room",
  session: "sess",
  invite: "inv",
  message: "msg",
  request: "req",
  task: "task",
  handoff: "hnd",
  audit: "aud",
} as const;

export type CollaborationIdKind = keyof typeof PREFIXES;

export function newCollaborationId(kind: CollaborationIdKind): string {
  return `${PREFIXES[kind]}_${randomUUID()}`;
}
