import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/contracts/index.js";
import {
  cleanupTestRoot,
  createCollaborationFixture,
  createTestClock,
  setupRoomWithReviewer,
  type CollaborationFixture,
  type RoomSetup,
  type TestClock,
} from "./helpers/fixture.js";
import type { CollaborationService, TaskView } from "../../src/collaboration/index.js";

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
    expect((error as DomainError).hint).toBeTruthy();
    return error as DomainError;
  }
  throw new Error(`Esperava DomainError ${code}, mas nao houve erro.`);
}

function sufficientHandoff(service: CollaborationService, workerToken: string, taskId: string): void {
  service.submitHandoff(service.authenticate(workerToken), {
    taskId,
    objective: "Implementei a tela e validei o fluxo completo com testes locais.",
    changes: [{ path: "src/login.html", kind: "created" }],
    tests: [{ name: "npm run typecheck", passed: true }],
    decisions: ["Mantive o CSS existente"],
    pending: ["Revisao visual"],
    nextStep: "Revisar com o coordinator",
  });
}

async function prepareTask(
  service: CollaborationService,
  setup: RoomSetup,
  clock: TestClock,
  title: string,
  options: { readonly dependsOn?: readonly string[] } = {},
): Promise<TaskView> {
  clock.advance(1000);
  const coordinator = service.authenticate(setup.coordinatorToken);
  const task = service.proposeTask(coordinator, {
    title,
    description: `Descricao de ${title}`,
    assigneeAgentId: setup.workerAgentId,
    dependsOn: options.dependsOn,
  });
  const worker = service.authenticate(setup.workerToken);
  return service.updateTask(worker, { taskId: task.id, action: "accept" }).task;
}

describe("tarefas: transicoes e autorizacao", () => {
  it("fluxo accept/start/block/unblock/progress/complete com handoff obrigatorio", async () => {
    const clock = createTestClock();
    const { service } = fixture({ clock });
    const setup = await setupRoomWithReviewer(service, clock);
    const coordinator = service.authenticate(setup.coordinatorToken);
    const worker = service.authenticate(setup.workerToken);

    clock.advance(1000);
    const task = service.proposeTask(coordinator, {
      title: "Migrar login",
      description: "login.html, login.css e login.js",
      assigneeAgentId: setup.workerAgentId,
    });
    expect(task.status).toBe("proposed");
    expect(task.assigneeAgentId).toBe(setup.workerAgentId);

    // Coordinator nao executa a tarefa de outro agente.
    expectDomainError(
      () => service.updateTask(coordinator, { taskId: task.id, action: "accept" }),
      "FORBIDDEN",
    );

    const accepted = service.updateTask(worker, { taskId: task.id, action: "accept" });
    expect(accepted.task.status).toBe("accepted");

    // progress exige nota.
    expectDomainError(
      () => service.updateTask(worker, { taskId: task.id, action: "progress" }),
      "VALIDATION_FAILED",
    );

    const started = service.updateTask(worker, { taskId: task.id, action: "start" });
    expect(started.task.status).toBe("in_progress");

    const blocked = service.updateTask(worker, {
      taskId: task.id,
      action: "block",
      note: "Aguardando API de login",
    });
    expect(blocked.task.status).toBe("blocked");
    expect(blocked.task.blockedReason).toMatch(/Aguardando/);
    expect(blocked.message?.kind).toBe("blocker");

    const unblocked = service.updateTask(worker, { taskId: task.id, action: "unblock" });
    expect(unblocked.task.status).toBe("in_progress");

    const progress = service.updateTask(worker, {
      taskId: task.id,
      action: "progress",
      note: "Tela de login concluida",
    });
    expect(progress.message?.kind).toBe("progress");

    // Sem handoff: nao conclui.
    const withoutHandoff = expectDomainError(
      () => service.updateTask(worker, { taskId: task.id, action: "complete" }),
      "INVALID_STATE",
    );
    expect(withoutHandoff.hint).toMatch(/handoff/i);

    // Handoff "done" vazio nao e suficiente.
    clock.advance(1000);
    const badHandoff = service.submitHandoff(worker, {
      taskId: task.id,
      objective: "done",
      tests: [],
    });
    const insufficient = expectDomainError(
      () => service.updateTask(worker, { taskId: task.id, action: "complete" }),
      "VALIDATION_FAILED",
    );
    expect(insufficient.hint).toMatch(/10 caracteres/);
    expect(insufficient.hint).toMatch(/tests/);

    // Handoff suficiente conclui e devolve o handoff correto.
    clock.advance(1000);
    sufficientHandoff(service, setup.workerToken, task.id);
    const completed = service.updateTask(worker, { taskId: task.id, action: "complete" });
    expect(completed.task.status).toBe("completed");
    expect(completed.task.completedAt).toBeDefined();
    expect(completed.handoff?.fromAgentId).toBe(setup.workerAgentId);
    expect(completed.handoff?.id).not.toBe(badHandoff.id);

    expectDomainError(
      () => service.updateTask(worker, { taskId: task.id, action: "complete" }),
      "INVALID_STATE",
    );

    const tasks = service.listTasks(coordinator);
    const loaded = tasks.find((item) => item.id === task.id);
    expect(loaded?.status).toBe("completed");
    expect(loaded?.handoffCount).toBe(2);
    expect(loaded?.latestHandoffId).toBe(completed.handoff?.id);
  });

  it("dependencias bloqueiam start ate a conclusao da tarefa anterior", async () => {
    const clock = createTestClock();
    const { service } = fixture({ clock });
    const setup = await setupRoomWithReviewer(service, clock);
    const worker = service.authenticate(setup.workerToken);

    const first = await prepareTask(service, setup, clock, "Tela de login");
    const second = service.proposeTask(service.authenticate(setup.coordinatorToken), {
      title: "Tela de dashboard",
      assigneeAgentId: setup.workerAgentId,
      dependsOn: [first.id],
    });
    service.updateTask(worker, { taskId: second.id, action: "accept" });
    const blockedByDependency = expectDomainError(
      () => service.updateTask(worker, { taskId: second.id, action: "start" }),
      "INVALID_STATE",
    );
    expect(blockedByDependency.hint).toMatch(/dependencias/i);

    service.updateTask(worker, { taskId: first.id, action: "start" });
    clock.advance(1000);
    sufficientHandoff(service, setup.workerToken, first.id);
    service.updateTask(worker, { taskId: first.id, action: "complete" });

    const started = service.updateTask(worker, { taskId: second.id, action: "start" });
    expect(started.task.status).toBe("in_progress");
  });

  it("nao aceita dependencia de outra sala e nao aceita agente de fora", async () => {
    const clock = createTestClock();
    const { service } = fixture({ clock });
    const setup = await setupRoomWithReviewer(service, clock);
    const coordinator = service.authenticate(setup.coordinatorToken);
    const otherRoom = await service.createRoom({
      displayName: "Outro",
      roomName: "Outra sala",
      workspaceId: "ws_other",
    });
    const otherCoordinator = service.authenticate(otherRoom.sessionToken);
    const otherTask = service.proposeTask(otherCoordinator, { title: "Tarefa externa" });

    expectDomainError(
      () =>
        service.proposeTask(coordinator, {
          title: "Tarefa dependente",
          dependsOn: [otherTask.id],
        }),
      "NOT_FOUND",
    );

    expectDomainError(
      () =>
        service.proposeTask(coordinator, {
          title: "Tarefa invalida",
          assigneeAgentId: otherCoordinator.agent.id,
        }),
      "NOT_FOUND",
    );
  });

  it("reatribuicao reinicia para proposed e impede alteracao por agente indevido", async () => {
    const clock = createTestClock();
    const { service } = fixture({ clock });
    const setup = await setupRoomWithReviewer(service, clock);
    const coordinator = service.authenticate(setup.coordinatorToken);
    const worker = service.authenticate(setup.workerToken);
    const reviewer = service.authenticate(setup.reviewerToken);

    clock.advance(1000);
    const task = service.proposeTask(coordinator, {
      title: "Tarefa disputada",
      assigneeAgentId: setup.workerAgentId,
    });
    expectDomainError(
      () => service.updateTask(reviewer, { taskId: task.id, action: "accept" }),
      "FORBIDDEN",
    );

    const reassigned = service.assignTask(coordinator, {
      taskId: task.id,
      assigneeAgentId: setup.reviewerAgentId,
    });
    expect(reassigned.status).toBe("proposed");
    expect(reassigned.assigneeAgentId).toBe(setup.reviewerAgentId);

    expectDomainError(
      () => service.updateTask(worker, { taskId: task.id, action: "accept" }),
      "FORBIDDEN",
    );
    const accepted = service.updateTask(reviewer, { taskId: task.id, action: "accept" });
    expect(accepted.task.status).toBe("accepted");

    expectDomainError(
      () => service.updateTask(worker, { taskId: task.id, action: "cancel" }),
      "FORBIDDEN",
    );
    const cancelled = service.updateTask(coordinator, {
      taskId: task.id,
      action: "cancel",
      reason: "Escopo removido",
    });
    expect(cancelled.task.status).toBe("cancelled");

    // Terminal nao aceita novas acoes nem reatribuicao.
    expectDomainError(
      () => service.updateTask(coordinator, { taskId: task.id, action: "cancel" }),
      "INVALID_STATE",
    );
    expectDomainError(
      () =>
        service.assignTask(coordinator, {
          taskId: task.id,
          assigneeAgentId: setup.workerAgentId,
        }),
      "INVALID_STATE",
    );
  });

  it("tarefa de outra sala nao e acessivel nem listada", async () => {
    const clock = createTestClock();
    const { service } = fixture({ clock });
    const setup = await setupRoomWithReviewer(service, clock);
    const coordinator = service.authenticate(setup.coordinatorToken);
    const otherRoom = await service.createRoom({
      displayName: "Outro",
      roomName: "Outra sala",
      workspaceId: "ws_other",
    });
    const otherCoordinator = service.authenticate(otherRoom.sessionToken);
    const otherTask = service.proposeTask(otherCoordinator, { title: "Externa" });

    const tasks = service.listTasks(coordinator);
    expect(tasks.map((task) => task.id)).not.toContain(otherTask.id);
    expectDomainError(
      () => service.assignTask(coordinator, { taskId: otherTask.id, assigneeAgentId: setup.workerAgentId }),
      "NOT_FOUND",
    );
  });
});

describe("handoffs: autoria, suficiencia e revisao", () => {
  it("somente o agente atribuido envia handoff e a conclusao preserva autoria", async () => {
    const clock = createTestClock();
    const { service } = fixture({ clock });
    const setup = await setupRoomWithReviewer(service, clock);
    const coordinator = service.authenticate(setup.coordinatorToken);
    const worker = service.authenticate(setup.workerToken);
    const reviewer = service.authenticate(setup.reviewerToken);

    const task = await prepareTask(service, setup, clock, "Tarefa com autoria");
    service.updateTask(worker, { taskId: task.id, action: "start" });

    expectDomainError(
      () =>
        service.submitHandoff(reviewer, {
          taskId: task.id,
          objective: "Handoff de terceiro indevido",
          tests: [{ name: "x", passed: true }],
        }),
      "FORBIDDEN",
    );
    expectDomainError(
      () =>
        service.submitHandoff(coordinator, {
          taskId: task.id,
          objective: "Handoff do coordinator indevido",
          tests: [{ name: "x", passed: true }],
        }),
      "FORBIDDEN",
    );

    clock.advance(1000);
    const handoff = service.submitHandoff(worker, {
      taskId: task.id,
      objective: "Conclui a tela de login com validacao manual e automatizada.",
      tests: [{ name: "npm test", passed: true }],
    });
    expect(handoff.fromAgentId).toBe(setup.workerAgentId);

    const completed = service.updateTask(worker, { taskId: task.id, action: "complete" });
    expect(completed.task.status).toBe("completed");
    expect(completed.handoff?.fromAgentId).toBe(setup.workerAgentId);
  });

  it("handoff mais recente por ordem de insercao mesmo no mesmo milissegundo", async () => {
    const clock = createTestClock();
    const { service } = fixture({ clock });
    const setup = await setupRoomWithReviewer(service, clock);
    const worker = service.authenticate(setup.workerToken);

    const task = await prepareTask(service, setup, clock, "Tarefa com dois handoffs");
    service.updateTask(worker, { taskId: task.id, action: "start" });

    // Sem avancar o relogio: created_at identico. rowid garante o mais recente.
    const bad = service.submitHandoff(worker, {
      taskId: task.id,
      objective: "curto",
      tests: [],
    });
    const good = service.submitHandoff(worker, {
      taskId: task.id,
      objective: "Implementei a tela com testes automatizados do fluxo.",
      tests: [{ name: "vitest", passed: true }],
    });

    const completed = service.updateTask(worker, { taskId: task.id, action: "complete" });
    expect(completed.task.status).toBe("completed");
    expect(completed.handoff?.id).toBe(good.id);
    expect(completed.handoff?.id).not.toBe(bad.id);
  });

  it("reviewer revisa handoff pendente; autor nao revisa o proprio handoff", async () => {
    const clock = createTestClock();
    const { service } = fixture({ clock });
    const setup = await setupRoomWithReviewer(service, clock);
    const coordinator = service.authenticate(setup.coordinatorToken);
    const worker = service.authenticate(setup.workerToken);
    const reviewer = service.authenticate(setup.reviewerToken);

    const task = await prepareTask(service, setup, clock, "Tarefa revisavel");
    service.updateTask(worker, { taskId: task.id, action: "start" });

    clock.advance(1000);
    const handoff = service.submitHandoff(worker, {
      taskId: task.id,
      objective: "Implementei a tela com cobertura de testes do fluxo principal.",
      tests: [{ name: "vitest", passed: true }],
      requestReview: true,
    });
    expect(handoff.reviewStatus).toBe("pending");

    // Sem reviewer/coordinator nao revisa; autor tambem nao.
    expectDomainError(
      () =>
        service.reviewHandoff(worker, {
          handoffId: handoff.id,
          decision: "approved",
        }),
      "FORBIDDEN",
    );

    const approved = service.reviewHandoff(reviewer, {
      handoffId: handoff.id,
      decision: "approved",
      notes: "Fluxo validado",
    });
    expect(approved.reviewStatus).toBe("approved");
    expect(approved.reviewedByAgentId).toBe(setup.reviewerAgentId);

    expectDomainError(
      () =>
        service.reviewHandoff(reviewer, {
          handoffId: handoff.id,
          decision: "approved",
        }),
      "INVALID_STATE",
    );

    // Handoff sem requestReview nao entra em revisao.
    clock.advance(1000);
    const second = service.submitHandoff(worker, {
      taskId: task.id,
      objective: "Segundo handoff sem solicitacao de revisao.",
      tests: [{ name: "build", passed: true }],
    });
    expect(second.reviewStatus).toBe("not_requested");
    expectDomainError(
      () =>
        service.reviewHandoff(reviewer, {
          handoffId: second.id,
          decision: "approved",
        }),
      "INVALID_STATE",
    );
    expect(coordinator.isCoordinator).toBe(true);
  });

  it("changes_requested exige notas e reviewer sem papel nao revisa", async () => {
    const clock = createTestClock();
    const { service } = fixture({ clock });
    const setup = await setupRoomWithReviewer(service, clock);
    const coordinator = service.authenticate(setup.coordinatorToken);
    const worker = service.authenticate(setup.workerToken);
    const reviewer = service.authenticate(setup.reviewerToken);

    const plainWorkerInvite = service.createInvite(coordinator, { reviewer: false });
    const plainWorker = service.joinRoom({
      inviteToken: plainWorkerInvite.inviteToken,
      displayName: "Codex 2",
      clientKind: "codex",
    });
    const plainWorkerActor = service.authenticate(plainWorker.sessionToken);

    const task = await prepareTask(service, setup, clock, "Tarefa com revisao");
    service.updateTask(worker, { taskId: task.id, action: "start" });
    clock.advance(1000);
    const handoff = service.submitHandoff(worker, {
      taskId: task.id,
      objective: "Implementei a tela e preciso de revisao de design.",
      tests: [{ name: "visual", passed: false }],
      requestReview: true,
    });

    expectDomainError(
      () =>
        service.reviewHandoff(plainWorkerActor, {
          handoffId: handoff.id,
          decision: "approved",
        }),
      "FORBIDDEN",
    );
    expectDomainError(
      () =>
        service.reviewHandoff(reviewer, {
          handoffId: handoff.id,
          decision: "changes_requested",
        }),
      "VALIDATION_FAILED",
    );

    const changes = service.reviewHandoff(reviewer, {
      handoffId: handoff.id,
      decision: "changes_requested",
      notes: "Ajustar contraste e estados de erro.",
    });
    expect(changes.reviewStatus).toBe("changes_requested");
    expect(changes.reviewNotes).toMatch(/contraste/);

    const listed = service.listHandoffs(coordinator, { taskId: task.id });
    expect(listed[0]?.id).toBe(handoff.id);
  });
});
