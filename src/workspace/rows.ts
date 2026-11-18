import { DomainError } from "../contracts/index.js";
import type { SqlRow } from "../persistence/index.js";
import { bytesFromDb } from "./content.js";

/** Leitura defensiva de linhas SQLite (sem expor conteudo bruto em erros). */
function corrupt(column: string): DomainError {
  return new DomainError("INTERNAL", "Registro de workspace/locking inconsistente.", {
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
  return fieldString(row, column);
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

export function fieldBytes(row: SqlRow, column: string): Uint8Array | null {
  return bytesFromDb(row[column]);
}
