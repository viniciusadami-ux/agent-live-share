import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createMigrationRegistry,
  foundationMigrations,
  getMetadata,
  MigrationError,
  openDatabase,
  readMigrationRecords,
  runMigrations,
  setMetadata,
  type DatabaseConnection,
  type Migration,
} from "../../src/persistence/index.js";
import { cleanupTestRoot, createTestDir } from "./helpers/tmp.js";

afterAll(cleanupTestRoot);

function freshDbPath(): string {
  return path.join(createTestDir("persistence"), "state.sqlite");
}

function tableExists(db: DatabaseConnection, name: string): boolean {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

describe("bootstrap SQLite", () => {
  it("abre conexao real, cria schema_migrations e aplica a migration 001", () => {
    const db = openDatabase(freshDbPath());
    try {
      expect(db.isOpen).toBe(true);
      expect(db.driver).toBe("better-sqlite3");

      const result = runMigrations(db, foundationMigrations);
      expect(result.applied.map((m) => m.version)).toEqual([1]);
      expect(result.currentVersion).toBe(1);
      expect(result.totalApplied).toBe(1);

      expect(tableExists(db, "schema_migrations")).toBe(true);
      expect(tableExists(db, "app_metadata")).toBe(true);
      expect(readMigrationRecords(db)).toHaveLength(1);
      expect(readMigrationRecords(db)[0]?.name).toBe("001_foundation_app_metadata");
    } finally {
      db.close();
    }
  });

  it("nao cria tabelas de dominio nesta etapa", () => {
    const db = openDatabase(freshDbPath());
    try {
      runMigrations(db, foundationMigrations);
      for (const domainTable of ["rooms", "participants", "messages", "tasks", "locks", "file_versions"]) {
        expect(tableExists(db, domainTable)).toBe(false);
      }
    } finally {
      db.close();
    }
  });
});

describe("persistencia ao fechar/reabrir", () => {
  it("mantem dados e migrations apos close() + openDatabase() no mesmo arquivo", () => {
    const dbPath = freshDbPath();

    const first = openDatabase(dbPath);
    runMigrations(first, foundationMigrations);
    setMetadata(first, "probe", "valor-persistido");
    expect(getMetadata(first, "probe")).toBe("valor-persistido");
    first.close();
    expect(first.isOpen).toBe(false);

    const second = openDatabase(dbPath);
    try {
      const again = runMigrations(second, foundationMigrations);
      expect(again.applied).toHaveLength(0);
      expect(again.currentVersion).toBe(1);
      expect(getMetadata(second, "probe")).toBe("valor-persistido");
      expect(readMigrationRecords(second)).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  it("close() e idempotente", () => {
    const db = openDatabase(freshDbPath());
    runMigrations(db, foundationMigrations);
    db.close();
    expect(() => db.close()).not.toThrow();
    expect(db.isOpen).toBe(false);
  });
});

describe("migrations versionadas", () => {
  it("runMigrations e idempotente em execucoes repetidas", () => {
    const db = openDatabase(freshDbPath());
    try {
      runMigrations(db, foundationMigrations);
      runMigrations(db, foundationMigrations);
      const third = runMigrations(db, foundationMigrations);
      expect(third.applied).toHaveLength(0);
      expect(readMigrationRecords(db)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("MigrationRegistry permite a modulos futuros adicionarem tabelas sem tocar no nucleo", () => {
    const dbPath = freshDbPath();
    const moduleMigration: Migration = {
      version: 2,
      name: "002_future_module_probe",
      up(db): void {
        db.exec("CREATE TABLE future_module_probe (id INTEGER PRIMARY KEY NOT NULL);");
      },
    };

    const registry = createMigrationRegistry(foundationMigrations);
    registry.register(moduleMigration);

    const first = openDatabase(dbPath);
    const result = runMigrations(first, registry);
    expect(result.applied.map((m) => m.version)).toEqual([1, 2]);
    expect(result.currentVersion).toBe(2);
    expect(tableExists(first, "future_module_probe")).toBe(true);
    first.close();

    const second = openDatabase(dbPath);
    try {
      const again = runMigrations(second, registry);
      expect(again.applied).toHaveLength(0);
      expect(again.totalApplied).toBe(2);
      expect(tableExists(second, "future_module_probe")).toBe(true);
    } finally {
      second.close();
    }
  });

  it("rollback completo quando uma migration falha no meio da transacao", () => {
    const db = openDatabase(freshDbPath());
    try {
      const failing: Migration = {
        version: 3,
        name: "003_failing_probe",
        up(inner): void {
          inner.exec("CREATE TABLE should_not_exist (id INTEGER);");
          throw new Error("falha-induzida");
        },
      };

      expect(() => runMigrations(db, [...foundationMigrations, failing])).toThrow(
        /falha-induzida/,
      );
      expect(tableExists(db, "should_not_exist")).toBe(false);
      expect(tableExists(db, "app_metadata")).toBe(false);
      expect(readMigrationRecords(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("rejeita versao duplicada", () => {
    const db = openDatabase(freshDbPath());
    try {
      const duplicate: Migration = {
        version: 1,
        name: "001_duplicate",
        up(): void {},
      };
      expect(() => runMigrations(db, [...foundationMigrations, duplicate])).toThrow(
        MigrationError,
      );
    } finally {
      db.close();
    }
  });

  it("detecta drift: mesma versao aplicada com outro nome", () => {
    const db = openDatabase(freshDbPath());
    try {
      const renamed: Migration = { version: 1, name: "001_nome_antigo", up(): void {} };
      runMigrations(db, [renamed]);
      expect(() => runMigrations(db, foundationMigrations)).toThrow(/Drift de migration/);
    } finally {
      db.close();
    }
  });

  it("transacao explicita faz rollback em caso de excecao", () => {
    const db = openDatabase(freshDbPath());
    try {
      runMigrations(db, foundationMigrations);
      expect(() =>
        db.transaction(() => {
          setMetadata(db, "rollback-probe", "nao-deve-ficar");
          throw new Error("rollback");
        }),
      ).toThrow(/rollback/);
      expect(getMetadata(db, "rollback-probe")).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
