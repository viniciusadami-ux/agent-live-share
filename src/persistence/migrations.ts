import type { DatabaseConnection, Migration, SqlRow } from "./types.js";

/**
 * Runner de migrations versionadas, idempotente e transacional.
 *
 * - `schema_migrations` e a tabela de CONTROLE, criada pelo runner.
 * - Cada `Migration.up` roda dentro da MESMA transacao em que o registro e
 *   gravado: se falhar, nada fica aplicado pela metade.
 * - Reexecutar com o mesmo conjunto nao aplica nada (idempotente).
 * - Versao ja aplicada com outro `name` e erro: protege contra drift.
 *
 * PONTO DE COMPOSICAO: os proximos modulos apenas adicionam migrations ao
 * array passado a `runMigrations` (ou ao `MigrationRegistry`). Nenhuma mudanca
 * neste arquivo e necessaria para criar novas tabelas de dominio.
 */

export const MIGRATIONS_TABLE = "schema_migrations";

export interface MigrationRecord {
  readonly version: number;
  readonly name: string;
  readonly appliedAt: string;
}

export interface MigrationRunResult {
  /** Migrations aplicadas NESTA execucao (vazio na segunda chamada). */
  readonly applied: readonly MigrationRecord[];
  readonly currentVersion: number;
  readonly totalApplied: number;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

export interface MigrationRegistry {
  register(migration: Migration): void;
  registerAll(migrations: readonly Migration[]): void;
  list(): readonly Migration[];
}

export function createMigrationRegistry(initial: readonly Migration[] = []): MigrationRegistry {
  const items: Migration[] = [...initial];
  return {
    register(migration): void {
      items.push(migration);
    },
    registerAll(migrations): void {
      items.push(...migrations);
    },
    list(): readonly Migration[] {
      return [...items].sort((a, b) => a.version - b.version);
    },
  };
}

function normalize(migrations: readonly Migration[]): Migration[] {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const seen = new Set<number>();
  for (const migration of sorted) {
    if (!Number.isInteger(migration.version) || migration.version <= 0) {
      throw new MigrationError(
        `Migration "${migration.name}" tem versao invalida (${migration.version}); use inteiro positivo.`,
      );
    }
    if (seen.has(migration.version)) {
      throw new MigrationError(`Versao de migration duplicada: ${migration.version}.`);
    }
    seen.add(migration.version);
  }
  return sorted;
}

function toRecord(row: SqlRow): MigrationRecord {
  return {
    version: Number(row["version"]),
    name: String(row["name"]),
    appliedAt: String(row["applied_at"]),
  };
}

/** Le os registros ja aplicados (util para health/diagnostico e testes). */
export function readMigrationRecords(db: DatabaseConnection): readonly MigrationRecord[] {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(MIGRATIONS_TABLE);
  if (exists === undefined) return [];
  return db
    .prepare(`SELECT version, name, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY version ASC`)
    .all()
    .map(toRecord);
}

export function runMigrations(
  db: DatabaseConnection,
  source: readonly Migration[] | MigrationRegistry,
): MigrationRunResult {
  const migrations = normalize("list" in source ? source.list() : source);

  return db.transaction<MigrationRunResult>(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        version     INTEGER PRIMARY KEY NOT NULL,
        name        TEXT NOT NULL,
        applied_at  TEXT NOT NULL
      );
    `);

    const known = new Map<number, string>();
    for (const record of readMigrationRecords(db)) {
      known.set(record.version, record.name);
    }

    const applied: MigrationRecord[] = [];
    for (const migration of migrations) {
      const previousName = known.get(migration.version);
      if (previousName !== undefined) {
        if (previousName !== migration.name) {
          throw new MigrationError(
            `Drift de migration na versao ${migration.version}: ` +
              `aplicada como "${previousName}", agora registrada como "${migration.name}".`,
          );
        }
        continue;
      }

      migration.up(db);
      const appliedAt = new Date().toISOString();
      db.prepare(
        `INSERT INTO ${MIGRATIONS_TABLE} (version, name, applied_at) VALUES (?, ?, ?)`,
      ).run(migration.version, migration.name, appliedAt);

      applied.push({ version: migration.version, name: migration.name, appliedAt });
      known.set(migration.version, migration.name);
    }

    const versions = [...known.keys()];
    return {
      applied,
      currentVersion: versions.length === 0 ? 0 : Math.max(...versions),
      totalApplied: known.size,
    };
  });
}
