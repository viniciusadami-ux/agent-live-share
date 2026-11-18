import { DomainError, isRole, type Role } from "../contracts/index.js";
import type { SqlRow } from "../persistence/index.js";

/**
 * Leitura defensiva de linhas SQLite. Qualquer inconsistencia de schema vira
 * INTERNAL sem expor conteudo bruto (que pode conter mensagem de usuario).
 */

function corrupt(column: string): DomainError {
  return new DomainError("INTERNAL", "Registro de colaboracao inconsistente.", {
    hint: "Verifique a integridade do SQLite e as migrations aplicadas.",
    context: { column },
  });
}

export function fieldString(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw corrupt(column);
  return value;
}

export function fieldOptionalString(row: SqlRow, column: string): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw corrupt(column);
  return value;
}

export function fieldNumber(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  throw corrupt(column);
}

export function fieldOptionalNumber(row: SqlRow, column: string): number | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  return fieldNumber(row, column);
}

export function fieldBoolean(row: SqlRow, column: string): boolean {
  const value = fieldNumber(row, column);
  if (value !== 0 && value !== 1) throw corrupt(column);
  return value === 1;
}

export function parseJsonColumn(raw: string, column: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw corrupt(column);
  }
}

export function parseJsonObjectColumn(
  raw: string,
  column: string,
): Readonly<Record<string, unknown>> {
  const parsed = parseJsonColumn(raw, column);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw corrupt(column);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

export function parseJsonArrayColumn(raw: string, column: string): readonly unknown[] {
  const parsed = parseJsonColumn(raw, column);
  if (!Array.isArray(parsed)) throw corrupt(column);
  return parsed;
}

function dedupeRoles(roles: readonly Role[]): readonly Role[] {
  const seen = new Set<Role>();
  const result: Role[] = [];
  for (const role of roles) {
    if (!seen.has(role)) {
      seen.add(role);
      result.push(role);
    }
  }
  return result;
}

export function parseRolesColumn(raw: string): readonly Role[] {
  const values = parseJsonArrayColumn(raw, "roles");
  const roles: Role[] = [];
  for (const value of values) {
    if (!isRole(value)) throw corrupt("roles");
    roles.push(value);
  }
  return dedupeRoles(roles);
}

export function parseStringArrayColumn(raw: string, column: string): readonly string[] {
  const values = parseJsonArrayColumn(raw, column);
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") throw corrupt(column);
    result.push(value);
  }
  return result;
}

export function rolesToJson(roles: readonly Role[]): string {
  return JSON.stringify(dedupeRoles(roles));
}

export function stringArrayToJson(values: readonly string[]): string {
  return JSON.stringify(values);
}

/** JSON serializavel e objeto; usado para payload de eventos/handoffs. */
export function toJsonText(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error("undefined");
    return text;
  } catch {
    throw new DomainError("INTERNAL", "Nao foi possivel serializar o registro.", {
      hint: "Verifique os dados enviados e tente novamente.",
    });
  }
}
