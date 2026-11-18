import fs from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type { DatabaseConnection, SqlRow, SqlStatement } from "./types.js";

/**
 * Bootstrap SQLite. `better-sqlite3` foi escolhido por ser sincrono (ideal para
 * locks atomicos e transacoes das proximas frentes), ter API estavel e distribuir
 * prebuilds para Windows (sem toolchain de compilacao no host).
 *
 * journal_mode fica no padrao DELETE nesta fundacao: um unico processo abre o
 * arquivo e isso evita artefatos -wal/-shm em testes no Windows.
 */
export const SQLITE_DRIVER = "better-sqlite3";

type RawDatabase = InstanceType<typeof BetterSqlite3>;

/** Os tipos do driver usam genericos de tupla; esta vista normaliza para rest. */
interface NativeStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

function adaptStatement(statement: ReturnType<RawDatabase["prepare"]>): SqlStatement {
  const native = statement as unknown as NativeStatement;
  return {
    run: (...params) => ({ changes: native.run(...params).changes }),
    get: (...params) => native.get(...params) as SqlRow | undefined,
    all: (...params) => native.all(...params) as readonly SqlRow[],
  };
}

export function openDatabase(dbPath: string): DatabaseConnection {
  const isMemory = dbPath === ":memory:";
  const resolved = isMemory ? dbPath : path.resolve(dbPath);

  if (!isMemory) {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
  }

  const raw = new BetterSqlite3(resolved);
  raw.pragma("foreign_keys = ON");
  raw.pragma("busy_timeout = 5000");

  let open = true;

  const connection: DatabaseConnection = {
    path: resolved,
    driver: SQLITE_DRIVER,
    get isOpen(): boolean {
      return open;
    },
    exec(sql: string): void {
      raw.exec(sql);
    },
    prepare(sql: string): SqlStatement {
      return adaptStatement(raw.prepare(sql));
    },
    transaction<T>(fn: () => T): T {
      return raw.transaction(fn)();
    },
    close(): void {
      if (!open) return;
      raw.close();
      open = false;
    },
  };

  return connection;
}
