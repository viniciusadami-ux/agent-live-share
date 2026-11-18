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
  createStaticWorkspaceDirectory,
  type CollaborationService,
} from "../../../src/collaboration/index.js";
import { cleanupTestRoot, createTestDir } from "../../foundation/helpers/tmp.js";

/**
 * Fixture de testes do modulo de colaboracao.
 *
 * - SQLite real em `.tmp-tests/` (nunca no workspace real);
 * - workspace directory estatico: `ws_test` existe, `ws_other` existe;
 * - relogio injetavel para expirar sessoes/convites de forma deterministica;
 * - `reopen()` fecha e reabre o MESMO arquivo para testar persistencia.
 */
export interface TestClock {
  current: Date;
  now(): Date;
  advance(ms: number): void;
  set(iso: string): void;
}

export function createTestClock(startIso = "2026-01-01T00:00:00.000Z"): TestClock {
  let currentMs = Date.parse(startIso);
  return {
    get current(): Date {
      return new Date(currentMs);
    },
    now(): Date {
      return new Date(currentMs);
    },
    advance(ms: number): void {
      currentMs += ms;
    },
    set(iso: string): void {
      currentMs = Date.parse(iso);
    },
  };
}

export interface CollaborationFixture {
  readonly dir: string;
  readonly dbPath: string;
  readonly clock: TestClock;
  readonly db: DatabaseConnection;
  readonly service: CollaborationService;
  close(): void;
  reopen(): CollaborationFixture;
}

export interface CreateFixtureOptions {
  readonly label?: string;
  readonly dbPath?: string;
  readonly clock?: TestClock;
  readonly workspaceIds?: readonly string[];
  readonly sessionTtlMs?: number;
  readonly inviteTtlMs?: number;
}

export const DEFAULT_TEST_SESSION_TTL_MS = 60_000;
export const DEFAULT_TEST_INVITE_TTL_MS = 60 * 60_000;

function openFixture(
  dbPath: string,
  clock: TestClock,
  workspaceIds: readonly string[],
  sessionTtlMs: number,
  inviteTtlMs: number,
): { db: DatabaseConnection; service: CollaborationService } {
  const db = openDatabase(dbPath);
  runMigrations(db, [
    ...foundationMigrations,
    ...collaborationMigrations,
    ...transportAuthMigrations,
  ]);
  const service = createCollaborationService({
    db,
    workspaceDirectory: createStaticWorkspaceDirectory(workspaceIds),
    now: clock.now,
    sessionTtlMs,
    inviteTtlMs,
    principalId: TEST_PRINCIPAL.id,
  });
  return { db, service };
}

export function createCollaborationFixture(
  options: CreateFixtureOptions = {},
): CollaborationFixture {
  const dir = options.dbPath === undefined ? createTestDir("collaboration") : path.dirname(options.dbPath);
  const dbPath = options.dbPath ?? path.join(dir, "collaboration.sqlite");
  const clock = options.clock ?? createTestClock();
  const workspaceIds = options.workspaceIds ?? ["ws_test", "ws_other"];
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_TEST_SESSION_TTL_MS;
  const inviteTtlMs = options.inviteTtlMs ?? DEFAULT_TEST_INVITE_TTL_MS;

  const opened = openFixture(dbPath, clock, workspaceIds, sessionTtlMs, inviteTtlMs);

  const fixture: CollaborationFixture = {
    dir,
    dbPath,
    clock,
    db: opened.db,
    service: opened.service,
    close(): void {
      opened.db.close();
    },
    reopen(): CollaborationFixture {
      opened.db.close();
      return createCollaborationFixture({
        dbPath,
        clock,
        workspaceIds,
        sessionTtlMs,
        inviteTtlMs,
      });
    },
  };
  return fixture;
}

export { cleanupTestRoot, createTestDir };

export interface RoomSetup {
  readonly roomId: string;
  readonly coordinatorToken: string;
  readonly coordinatorAgentId: string;
  readonly workerToken: string;
  readonly workerAgentId: string;
  readonly reviewerToken: string;
  readonly reviewerAgentId: string;
}

export async function setupRoomWithReviewer(
  service: CollaborationService,
  clock: TestClock,
): Promise<RoomSetup> {
  const room = await service.createRoom({
    displayName: "OpenCode",
    clientKind: "opencode",
    roomName: "Migracao de telas",
    workspaceId: "ws_test",
  });

  const workerInvite = service.createInvite(
    service.authenticate(room.sessionToken),
    { reviewer: false },
  );
  const worker = service.joinRoom({
    inviteToken: workerInvite.inviteToken,
    displayName: "Codex",
    clientKind: "codex",
  });

  const reviewerInvite = service.createInvite(
    service.authenticate(room.sessionToken),
    { reviewer: true },
  );
  const reviewer = service.joinRoom({
    inviteToken: reviewerInvite.inviteToken,
    displayName: "Claude Code",
    clientKind: "claude-code",
  });

  // O clock avanca um segundo apenas entre operacoes para ordenar eventos.
  clock.advance(1000);

  return {
    roomId: room.room.id,
    coordinatorToken: room.sessionToken,
    coordinatorAgentId: room.agent.id,
    workerToken: worker.sessionToken,
    workerAgentId: worker.agent.id,
    reviewerToken: reviewer.sessionToken,
    reviewerAgentId: reviewer.agent.id,
  };
}
