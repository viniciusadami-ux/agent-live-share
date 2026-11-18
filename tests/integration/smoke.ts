/**
 * Smoke real da APLICACAO INTEGRADA (`npm run smoke`).
 *
 * Sobe a mesma composicao do `src/index.ts` em porta efemera, com um workspace
 * fixture DENTRO do projeto, conecta dois clientes MCP oficiais, cria sala,
 * le um arquivo real, adquire lock, aplica patch e confere health/close.
 */
import { cleanupTestRoot } from "../foundation/helpers/tmp.js";
import { connectTestMcpClient } from "../foundation/helpers/mcpClient.js";
import {
  callOk,
  createIntegrationFixture,
  credentialOf,
  startIntegrationApp,
} from "./helpers/app.js";

async function main(): Promise<void> {
  const fixture = createIntegrationFixture();
  const app = await startIntegrationApp(fixture);
  console.log(`[smoke] app integrada em ${app.url} (porta ${app.port})`);
  console.log(`[smoke] migration v${app.migrationResult.currentVersion}, workspaces=${app.workspaceCount}`);

  try {
    const healthResponse = await fetch(app.healthUrl);
    const health = (await healthResponse.json()) as {
      status: string;
      persistence: { migrationVersion: number };
    };
    console.log(
      `[smoke] health HTTP ${healthResponse.status} -> ${health.status} (migration v${health.persistence.migrationVersion})`,
    );
    if (healthResponse.status !== 200 || health.status !== "ok") {
      throw new Error("health nao respondeu ok");
    }
    if (health.persistence.migrationVersion !== 30) {
      throw new Error("migration esperada: v30");
    }
    if (JSON.stringify(health).includes(fixture.root)) {
      throw new Error("health vazou root do workspace");
    }

    const credentialA = credentialOf(fixture, 0);
    const credentialB = credentialOf(fixture, 1);
    const a = await connectTestMcpClient(app.mcpUrl, credentialA.token);
    const b = await connectTestMcpClient(app.mcpUrl, credentialB.token);
    try {
      const { tools } = await a.client.listTools();
      console.log(`[smoke] tools registradas: ${tools.length}`);
      if (tools.length !== 37) throw new Error(`esperava 37 tools, obtive ${tools.length}`);

      const room = await callOk<{
        sessionToken: string;
        room: { workspaceId: string };
        agent: { id: string };
      }>(a, "collab_create_room", {
        displayName: "OpenCode",
        clientKind: "opencode",
        roomName: "Smoke integrado",
        workspaceId: "ws_integration",
      });
      const invite = await callOk<{ inviteToken: string }>(a, "collab_create_invite", {
        token: room.sessionToken,
      });
      const worker = await callOk<{ sessionToken: string; agent: { id: string } }>(
        b,
        "collab_join_room",
        { inviteToken: invite.inviteToken, displayName: "Codex", clientKind: "codex" },
      );
      console.log(
        `[smoke] room=${room.room.workspaceId} coordinator=${room.agent.id} worker=${worker.agent.id}`,
      );

      const read = await callOk<{ content: string; hash: string }>(
        a,
        "collab_read_file",
        { token: room.sessionToken, path: "login.html" },
      );
      if (!read.content.includes("Login")) throw new Error("leitura do fixture falhou");

      const lock = await callOk<{ lock: { id: string } }>(a, "collab_lock_acquire", {
        token: room.sessionToken,
        path: "login.html",
        intent: "smoke",
      });
      const patch = await callOk<{ version: number }>(a, "collab_apply_patch", {
        token: room.sessionToken,
        path: "login.html",
        lockId: lock.lock.id,
        expectedHash: read.hash,
        replacements: [{ oldText: "<h1>Login</h1>", newText: "<h1>Entrar</h1>" }],
      });
      if (patch.version !== 2) throw new Error(`versao esperada 2, obtida ${patch.version}`);
      await callOk(a, "collab_lock_release", {
        token: room.sessionToken,
        lockId: lock.lock.id,
      });
      const finalRead = await callOk<{ content: string }>(b, "collab_read_file", {
        token: worker.sessionToken,
        path: "login.html",
      });
      if (finalRead.content !== "<h1>Entrar</h1>\n") {
        throw new Error("worker nao viu o patch do coordinator");
      }
      console.log("[smoke] fluxo colaborativo real OK");
    } finally {
      await a.close();
      await b.close();
    }
  } finally {
    await app.close();
    cleanupTestRoot();
  }

  console.log("[smoke] start/stop + integracao OK");
}

main().catch((error: unknown) => {
  console.error("[smoke] FALHOU:", error);
  cleanupTestRoot();
  process.exit(1);
});
