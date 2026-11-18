import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/contracts/index.js";
import {
  cleanupTestRoot,
  createCollaborationFixture,
  createTestClock,
  setupRoomWithReviewer,
  type CollaborationFixture,
} from "./helpers/fixture.js";

const fixtures: CollaborationFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

afterAll(cleanupTestRoot);

function fixture(options?: Parameters<typeof createCollaborationFixture>[0]): CollaborationFixture {
  const created = createCollaborationFixture(options);
  fixtures.push(created);
  return created;
}

function expectDomainError(fn: () => unknown, code: DomainError["code"]): DomainError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    return error as DomainError;
  }
  throw new Error(`Esperava DomainError ${code}, mas nao houve erro.`);
}

describe("mensagens e atualizacoes por cursor", () => {
  it("isola mensagens diretas de terceiros e entrega broadcast da sala", async () => {
    const clock = createTestClock();
    const { service } = fixture({ clock });
    const setup = await setupRoomWithReviewer(service, clock);
    const coordinator = service.authenticate(setup.coordinatorToken);
    const worker = service.authenticate(setup.workerToken);
    const reviewer = service.authenticate(setup.reviewerToken);

    service.sendMessage(coordinator, { body: "broadcast-da-sala" });
    service.sendMessage(worker, { body: "segredo-B-para-A", toAgentId: setup.coordinatorAgentId });
    service.sendMessage(reviewer, { body: "segredo-C-para-B", toAgentId: setup.workerAgentId });

    const coordinatorUpdates = service.getUpdates(coordinator, { cursor: "0", limit: 200 });
    const workerUpdates = service.getUpdates(worker, { cursor: "0", limit: 200 });
    const reviewerUpdates = service.getUpdates(reviewer, { cursor: "0", limit: 200 });

    const messageBodies = (updates: typeof coordinatorUpdates): readonly string[] =>
      updates.events
        .filter((event) => event.type === "message.sent")
        .map((event) => String(event.payload["body"]));

    expect(messageBodies(coordinatorUpdates)).toEqual(
      expect.arrayContaining(["broadcast-da-sala", "segredo-B-para-A"]),
    );
    expect(messageBodies(coordinatorUpdates)).not.toContain("segredo-C-para-B");

    expect(messageBodies(workerUpdates)).toEqual(
      expect.arrayContaining(["broadcast-da-sala", "segredo-B-para-A", "segredo-C-para-B"]),
    );

    expect(messageBodies(reviewerUpdates)).toEqual(
      expect.arrayContaining(["broadcast-da-sala", "segredo-C-para-B"]),
    );
    expect(messageBodies(reviewerUpdates)).not.toContain("segredo-B-para-A");

    // Mensagem de sala continua visivel a todos; direta nao vaza para terceiro.
    expect(reviewerUpdates.events.some((event) => event.payload["body"] === "broadcast-da-sala")).toBe(
      true,
    );
  });

  it("nao permite mensagem direta para agente de outra sala", async () => {
    const clock = createTestClock();
    const { service } = fixture({ clock });
    const setup = await setupRoomWithReviewer(service, clock);
    const otherRoom = await service.createRoom({
      displayName: "Outro",
      roomName: "Sala isolada",
      workspaceId: "ws_other",
    });
    const outsider = service.authenticate(otherRoom.sessionToken);
    const coordinator = service.authenticate(setup.coordinatorToken);

    service.sendMessage(coordinator, { body: "mensagem-exclusiva-da-sala-1" });

    expectDomainError(
      () =>
        service.sendMessage(outsider, {
          body: "vazamento",
          toAgentId: setup.workerAgentId,
        }),
      "NOT_FOUND",
    );

    const outsiderUpdates = service.getUpdates(outsider, { cursor: "0", limit: 200 });
    expect(JSON.stringify(outsiderUpdates)).not.toContain("mensagem-exclusiva-da-sala-1");
    expect(outsiderUpdates.events.every((event) => event.actorAgentId !== setup.workerAgentId)).toBe(
      true,
    );
  });

  it("cursor e monotonico, sem duplicar eventos, com hasMore e nextCursor", async () => {
    const clock = createTestClock();
    const { service } = fixture({ clock });
    const setup = await setupRoomWithReviewer(service, clock);
    const coordinator = service.authenticate(setup.coordinatorToken);

    for (let index = 0; index < 7; index += 1) {
      service.sendMessage(coordinator, { body: `evento-${index}` });
    }

    const seen: string[] = [];
    let cursor = "0";
    let pages = 0;
    for (;;) {
      const page = service.getUpdates(coordinator, { cursor, limit: 2 });
      for (const event of page.events) seen.push(String(event.cursor));
      pages += 1;
      if (!page.hasMore) break;
      cursor = String(page.nextCursor);
      if (pages > 50) throw new Error("loop de paginacao");
    }

    expect(pages).toBeGreaterThan(1);
    expect(new Set(seen).size).toBe(seen.length);
    const numeric = seen.map(Number);
    for (let index = 1; index < numeric.length; index += 1) {
      expect(numeric[index]).toBeGreaterThan(numeric[index - 1] ?? 0);
    }

    const empty = service.getUpdates(coordinator, { cursor: seen[seen.length - 1] });
    expect(empty.events).toHaveLength(0);
    expect(empty.hasMore).toBe(false);
    expect(String(empty.nextCursor)).toBe(seen[seen.length - 1]);

    expectDomainError(
      () => service.getUpdates(coordinator, { cursor: "abc" }),
      "VALIDATION_FAILED",
    );
    // rowid SQLite e inteiro de 64 bits; cursores maiores sao rejeitados.
    expectDomainError(
      () => service.getUpdates(coordinator, { cursor: "9".repeat(20) }),
      "VALIDATION_FAILED",
    );
  });

  it("eventos e mensagens persistidos nao contem tokens/convites em texto puro", async () => {
    const clock = createTestClock();
    const { service, db } = fixture({ clock });
    const room = await service.createRoom({
      displayName: "OpenCode",
      roomName: "Sala",
      workspaceId: "ws_test",
    });
    const coordinator = service.authenticate(room.sessionToken);
    const invite = service.createInvite(coordinator, {});
    const joined = service.joinRoom({
      inviteToken: invite.inviteToken,
      displayName: "Codex",
    });
    service.sendMessage(coordinator, { body: "ola" });
    service.requestPlan(service.authenticate(joined.sessionToken), {
      subject: "Plano",
      details: "Divida as telas",
    });

    const dumps = [
      JSON.stringify(db.prepare("SELECT * FROM collab_events").all()),
      JSON.stringify(db.prepare("SELECT * FROM collab_messages").all()),
      JSON.stringify(db.prepare("SELECT * FROM collab_invites").all()),
      JSON.stringify(db.prepare("SELECT * FROM collab_sessions").all()),
    ].join("\n");

    expect(dumps).not.toContain(room.sessionToken);
    expect(dumps).not.toContain(joined.sessionToken);
    expect(dumps).not.toContain(invite.inviteToken);
    expect(dumps).not.toContain("token_hash=");
  });
});

describe("solicitacoes de plano e correlacao", () => {
  it("worker solicita ao coordinator da sala e somente ele responde", async () => {
    const clock = createTestClock();
    const { service } = fixture({ clock });
    const setup = await setupRoomWithReviewer(service, clock);
    const coordinator = service.authenticate(setup.coordinatorToken);
    const worker = service.authenticate(setup.workerToken);
    const reviewer = service.authenticate(setup.reviewerToken);

    const baseCursor = String(
      service.getUpdates(reviewer, { cursor: "0", limit: 200 }).nextCursor,
    );

    const requested = service.requestPlan(worker, {
      subject: "Plano da migracao",
      details: "Preciso de divisao entre login e dashboard.",
    });
    expect(requested.request.toAgentId).toBe(setup.coordinatorAgentId);
    expect(requested.request.fromAgentId).toBe(setup.workerAgentId);
    expect(requested.request.status).toBe("open");
    expect(requested.message.kind).toBe("request");

    expectDomainError(
      () =>
        service.respondToRequest(reviewer, {
          requestId: requested.request.id,
          body: "nao deveria responder",
        }),
      "FORBIDDEN",
    );
    expectDomainError(
      () =>
        service.respondToRequest(worker, {
          requestId: requested.request.id,
          body: "auto-resposta",
        }),
      "FORBIDDEN",
    );

    const answered = service.respondToRequest(coordinator, {
      requestId: requested.request.id,
      body: "OpenCode: login; Codex: dashboard.",
    });
    expect(answered.request.status).toBe("answered");
    expect(answered.request.responseMessageId).toBeDefined();
    expect(answered.message.kind).toBe("response");
    expect(answered.message.correlationId).toBe(requested.request.requestMessageId);

    expectDomainError(
      () =>
        service.respondToRequest(coordinator, {
          requestId: requested.request.id,
          body: "resposta duplicada",
        }),
      "INVALID_STATE",
    );

    const workerRequests = service.listRequests(worker);
    expect(workerRequests).toHaveLength(1);
    expect(workerRequests[0]?.responseBody).toMatch(/OpenCode/);

    const reviewerRequests = service.listRequests(reviewer);
    expect(reviewerRequests).toHaveLength(0);

    const coordinatorRequests = service.listRequests(coordinator);
    expect(coordinatorRequests.map((request) => request.id)).toContain(requested.request.id);

    // Eventos da solicitacao/resposta sao diretos: terceiro nao ve.
    const reviewerUpdates = service.getUpdates(reviewer, { cursor: baseCursor, limit: 200 });
    expect(
      reviewerUpdates.events.some(
        (event) => event.type === "request.created" || event.type === "request.answered",
      ),
    ).toBe(false);

    const workerUpdates = service.getUpdates(worker, { cursor: "0", limit: 200 });
    expect(workerUpdates.events.some((event) => event.type === "request.answered")).toBe(true);
  });

  it("coordinator nao solicita plano a si mesmo e coordinator atual pode responder", async () => {
    const clock = createTestClock();
    const { service } = fixture({ clock });
    const setup = await setupRoomWithReviewer(service, clock);
    let coordinator = service.authenticate(setup.coordinatorToken);
    const worker = service.authenticate(setup.workerToken);
    const reviewer = service.authenticate(setup.reviewerToken);

    expectDomainError(
      () => service.requestPlan(coordinator, { subject: "Plano" }),
      "INVALID_STATE",
    );

    const requested = service.requestPlan(worker, { subject: "Plano" });
    coordinator = service.transferCoordinator(coordinator, setup.reviewerAgentId)
      ? service.authenticate(setup.reviewerToken)
      : coordinator;
    const answered = service.respondToRequest(coordinator, {
      requestId: requested.request.id,
      body: "Plano definido pelo novo coordinator.",
    });
    expect(answered.request.status).toBe("answered");
    expect(answered.message.fromAgentId).toBe(setup.reviewerAgentId);
    expect(reviewer.isCoordinator).toBe(false);
  });
});
