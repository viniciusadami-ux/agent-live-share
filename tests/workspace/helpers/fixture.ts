import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  foundationMigrations,
  openDatabase,
  runMigrations,
  transportAuthMigrations,
  type DatabaseConnection,
} from "../../../src/persistence/index.js";
import { TEST_PRINCIPAL } from "../../../src/server/auth/principalContext.js";
import {
  collaborationMigrations,
  createCollaborationService,
  type CollaborationService,
} from "../../../src/collaboration/index.js";
import {
  createWorkspaceRuntime,
  workspaceMigrations,
  type MutationFileSystem,
  type WorkspaceDefinition,
  type WorkspaceLimits,
  type WorkspaceRuntime,
} from "../../../src/workspace/index.js";
import { lockingMigrations } from "../../../src/locking/index.js";
import {
  createTestClock,
  type TestClock,
} from "../../collaboration/helpers/fixture.js";
import {
  cleanupTestRoot,
  createTestDir,
} from "../../foundation/helpers/tmp.js";

/** Conteudo padrao dos arquivos de fixture (texto UTF-8, pequenos). */
export const FIXTURE_FILES: Readonly<Record<string, string>> = {
  "login.html": "<h1>Login</h1>\n",
  "README.md": "# Collab MCP fixture\n\nhello world\nsearchable-token AQUI\n",
  "src/app.ts": 'const greeting = "hello";\nexport default greeting;\n',
  "src/util.ts": "export function add(a, b) { return a + b; }\n",
  "shared.txt": "v1\n",
  ".git/config": "[core]\n\tbare = false\n",
  "node_modules/pkg/index.js": "module.exports = 1;\n",
};

export interface CreateWorkspaceFixtureOptions {
  readonly clock?: TestClock;
  readonly dbPath?: string;
  readonly limits?: Partial<WorkspaceLimits>;
  readonly fs?: MutationFileSystem;
  readonly sessionTtlMs?: number;
  readonly inviteTtlMs?: number;
}

export interface WorkspaceFixture {
  readonly dir: string;
  readonly root: string;
  readonly otherRoot: string;
  readonly dbPath: string;
  readonly db: DatabaseConnection;
  readonly runtime: WorkspaceRuntime;
  readonly collaboration: CollaborationService;
  readonly clock: TestClock;
  readonly definitions: readonly WorkspaceDefinition[];
  /** Escreve diretamente no host (simula conteudo pre-existente/edicao externa). */
  writeHostFile(relative: string, content: string): void;
  readHostFile(relative: string): string;
  writeOtherHostFile(relative: string, content: string): void;
  close(): void;
  /** Fecha e REABRE o mesmo SQLite, sem recriar os arquivos de fixture. */
  reopen(): WorkspaceFixture;
}

interface MaterializeOptions extends CreateWorkspaceFixtureOptions {
  readonly dir: string;
  readonly root: string;
  readonly otherRoot: string;
  readonly dbPath: string;
  readonly initFiles: boolean;
}

function materialize(options: MaterializeOptions): WorkspaceFixture {
  const { dir, root, otherRoot, dbPath, initFiles } = options;
  if (initFiles) {
    mkdirSync(path.join(root, "src"), { recursive: true });
    mkdirSync(path.join(root, ".git"), { recursive: true });
    mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    mkdirSync(otherRoot, { recursive: true });
    for (const [relative, content] of Object.entries(FIXTURE_FILES)) {
      const absolute = path.join(root, ...relative.split("/"));
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, content, "utf8");
    }
    writeFileSync(path.join(otherRoot, "login.html"), "<h1>OTHER WORKSPACE</h1>\n", "utf8");
    writeFileSync(path.join(otherRoot, "shared.txt"), "OUTRO\n", "utf8");
  } else {
    // Garante apenas que os diretorios ainda existem (nao sobrescreve conteudo).
    mkdirSync(root, { recursive: true });
    mkdirSync(otherRoot, { recursive: true });
  }

  const clock = options.clock ?? createTestClock();
  // Fixture de servico: o principal sentinela esta autorizado nos dois roots.
  // Sem allowedPrincipals a politica seria fail-closed e nenhuma tool passaria.
  const definitions: readonly WorkspaceDefinition[] = [
    {
      id: "ws_test",
      name: "Workspace de teste",
      rootPath: root,
      allowedPrincipals: [TEST_PRINCIPAL.id],
    },
    {
      id: "ws_other",
      name: "Outro workspace",
      rootPath: otherRoot,
      allowedPrincipals: [TEST_PRINCIPAL.id],
    },
  ];
  const sessionTtlMs = options.sessionTtlMs ?? 60_000;
  const inviteTtlMs = options.inviteTtlMs ?? 60 * 60_000;

  const db = openDatabase(dbPath);
  runMigrations(db, [
    ...foundationMigrations,
    ...collaborationMigrations,
    ...workspaceMigrations,
    ...lockingMigrations,
    ...transportAuthMigrations,
  ]);
  const runtime = createWorkspaceRuntime(db, {
    definitions,
    now: clock.now,
    catalogNow: clock.now,
    limits: options.limits,
    fs: options.fs,
    principalId: TEST_PRINCIPAL.id,
  });
  const collaboration = createCollaborationService({
    db,
    workspaceDirectory: runtime.catalog,
    now: clock.now,
    sessionTtlMs,
    inviteTtlMs,
    principalId: TEST_PRINCIPAL.id,
  });

  const writeHostFile = (relative: string, content: string): void => {
    const absolute = path.join(root, ...relative.split("/"));
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  };
  const readHostFile = (relative: string): string =>
    readFileSync(path.join(root, ...relative.split("/")), "utf8");
  const writeOtherHostFile = (relative: string, content: string): void => {
    const absolute = path.join(otherRoot, ...relative.split("/"));
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  };

  return {
    dir,
    root,
    otherRoot,
    dbPath,
    db,
    runtime,
    collaboration,
    clock,
    definitions,
    writeHostFile,
    readHostFile,
    writeOtherHostFile,
    close(): void {
      db.close();
    },
    reopen(): WorkspaceFixture {
      db.close();
      return materialize({
        dir,
        root,
        otherRoot,
        dbPath,
        clock,
        limits: options.limits,
        fs: options.fs,
        sessionTtlMs,
        inviteTtlMs,
        initFiles: false,
      });
    },
  };
}

export function createWorkspaceFixture(
  options: CreateWorkspaceFixtureOptions = {},
): WorkspaceFixture {
  const dir = options.dbPath === undefined ? createTestDir("ws") : path.dirname(options.dbPath);
  const root = path.join(dir, "root");
  const otherRoot = path.join(dir, "other-root");
  const dbPath = options.dbPath ?? path.join(dir, "collab.sqlite");
  return materialize({
    ...options,
    dir,
    root,
    otherRoot,
    dbPath,
    initFiles: true,
  });
}

export { cleanupTestRoot, createTestDir, createTestClock };
