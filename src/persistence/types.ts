/**
 * Superficie minima de banco consumida por TODOS os modulos.
 * Isolar o driver aqui permite trocar a implementacao sem reescrever o nucleo.
 */

export type SqlParam = null | string | number | bigint | Uint8Array;

export type SqlRow = Readonly<Record<string, unknown>>;

export interface SqlStatement {
  run(...params: SqlParam[]): { readonly changes: number };
  get(...params: SqlParam[]): SqlRow | undefined;
  all(...params: SqlParam[]): readonly SqlRow[];
}

export interface DatabaseConnection {
  readonly path: string;
  readonly driver: string;
  readonly isOpen: boolean;
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  /** Executa `fn` em uma transacao; qualquer excecao faz rollback completo. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/**
 * Uma migration e a unidade de extensao da persistencia.
 * Modulos futuros (collaboration, workspace, locking) registram suas
 * migrations sem alterar `runMigrations`.
 */
export interface Migration {
  /** Inteiro positivo, unico e monotonico entre todas as migrations. */
  readonly version: number;
  readonly name: string;
  /** Executado DENTRO de uma transacao, junto do registro em schema_migrations. */
  readonly up: (db: DatabaseConnection) => void;
}
