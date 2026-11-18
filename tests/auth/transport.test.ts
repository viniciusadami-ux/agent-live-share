import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import path from "node:path";
import type { Request } from "express";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { RunningApplication } from "../../src/application.js";
import { loadConfig, type ServerConfig } from "../../src/config/env.js";
import { DIAGNOSTICS_TOOL_NAME } from "../../src/server/diagnostics.js";
import { revokePrincipal } from "../../src/server/auth/principals.js";
import { createAuthRateLimiter } from "../../src/server/auth/rateLimit.js";
import {
  bearerTokenOf,
  clientAddressOf,
} from "../../src/server/auth/transportAuth.js";
import { startServer, type RunningServer } from "../../src/server/httpServer.js";
import { connectTestMcpClient, type TestMcpClient } from "../foundation/helpers/mcpClient.js";
import { createTestDir } from "../foundation/helpers/tmp.js";
import { issueTestCredential } from "../helpers/auth.js";
import { callOk } from "../integration/helpers/app.js";
import {
  authHeaders,
  cleanupTestRoot,
  createCapturingLogger,
  initializeBody,
  startAuthTestApp,
  toolsListBody,
} from "./helpers.js";

const apps: RunningApplication[] = [];
const servers: RunningServer[] = [];
const clients: TestMcpClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    try {
      await client.close();
    } catch {
      /* ja fechado */
    }
  }
  for (const app of apps.splice(0)) {
    try {
      await app.close();
    } catch {
      /* ja fechado */
    }
  }
  for (const server of servers.splice(0)) {
    try {
      await server.close();
    } catch {
      /* ja fechado */
    }
  }
});
afterAll(cleanupTestRoot);

async function postMcp(
  url: string,
  headers: Record<string, string>,
  body: string = toolsListBody(),
): Promise<Response> {
  return fetch(url, { method: "POST", headers, body });
}

function fakeRequest(
  headers: Record<string, string | string[] | undefined>,
  remoteAddress = "127.0.0.1",
): Request {
  return {
    headers,
    socket: { remoteAddress },
  } as unknown as Request;
}

function hostProbe(port: number, path: string, hostHeader: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET", headers: { Host: hostHeader } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("parsing de Authorization e chave de rate limiting", () => {
  it("Bearer e case-insensitive e tolera espacos nas bordas, sem aceitar dois tokens", () => {
    expect(bearerTokenOf(fakeRequest({ authorization: "Bearer abc" }))).toBe("abc");
    expect(bearerTokenOf(fakeRequest({ authorization: "bearer abc" }))).toBe("abc");
    expect(bearerTokenOf(fakeRequest({ authorization: "BearEr    abc" }))).toBe("abc");
    expect(bearerTokenOf(fakeRequest({ authorization: "  Bearer abc  " }))).toBe("abc");
    expect(bearerTokenOf(fakeRequest({ authorization: "Basic abc" }))).toBeUndefined();
    expect(bearerTokenOf(fakeRequest({ authorization: "Bearer a b" }))).toBeUndefined();
    expect(bearerTokenOf(fakeRequest({ authorization: "Bearer " }))).toBeUndefined();
    expect(
      bearerTokenOf(fakeRequest({ authorization: ["Bearer a", "Bearer b"] })),
    ).toBeUndefined();
  });

  it("X-Forwarded-For so e usado com proxy confiavel, IP literal e par autorizado", () => {
    const disabled = { enabled: false, proxyAddresses: ["127.0.0.1"] };
    const enabled = { enabled: true, proxyAddresses: ["127.0.0.1", "::1"] };

    expect(
      clientAddressOf(
        fakeRequest({ "x-forwarded-for": "203.0.113.9" }),
        disabled,
      ),
    ).toBe("127.0.0.1");
    expect(
      clientAddressOf(
        fakeRequest({ "x-forwarded-for": "203.0.113.9" }, "10.0.0.5"),
        enabled,
      ),
    ).toBe("10.0.0.5");
    expect(
      clientAddressOf(
        fakeRequest({ "x-forwarded-for": "203.0.113.9, 10.0.0.5" }),
        enabled,
      ),
    ).toBe("203.0.113.9");
    expect(
      clientAddressOf(
        fakeRequest({ "x-forwarded-for": ["198.51.100.7, 10.0.0.5"] }),
        enabled,
      ),
    ).toBe("198.51.100.7");
    expect(
      clientAddressOf(
        fakeRequest({ "x-forwarded-for": "nao-e-um-ip; DROP TABLE" }),
        enabled,
      ),
    ).toBe("127.0.0.1");
    expect(
      clientAddressOf(
        fakeRequest({ "x-forwarded-for": "::ffff:203.0.113.9" }, "::ffff:127.0.0.1"),
        enabled,
      ),
    ).toBe("203.0.113.9");
  });
});

describe("autenticacao de transporte — 401/403/429", () => {
  it("401 IDENTICO para header ausente, formato invalido, token inexistente e revogado", async () => {
    // Limites altos isolam ESTE teste do rate limiting (testado separadamente).
    const { app, credentialA } = await startAuthTestApp({
      authRateLimit: { maxFailures: 100, windowMs: 60_000, blockMs: 1_000 },
    });
    apps.push(app);
    revokePrincipal(app.database, String(credentialA.id));

    const cases: ReadonlyArray<{ readonly label: string; readonly headers: Record<string, string> }> = [
      { label: "sem header", headers: authHeaders() },
      { label: "Basic", headers: { ...authHeaders(), Authorization: "Basic Zm9v" } },
      { label: "Bearer vazio", headers: { ...authHeaders(), Authorization: "Bearer " } },
      { label: "Bearer com dois tokens", headers: { ...authHeaders(), Authorization: "Bearer a b" } },
      { label: "token inexistente", headers: authHeaders("collab_p_inexistente") },
      { label: "token revogado", headers: authHeaders(credentialA.token) },
    ];

    const observed: Array<{ status: number; www: string | null; body: string }> = [];
    for (const testCase of cases) {
      const response = await postMcp(app.mcpUrl, testCase.headers);
      observed.push({
        status: response.status,
        www: response.headers.get("www-authenticate"),
        body: await response.text(),
      });
    }

    for (const [index, result] of observed.entries()) {
      expect(result.status, cases[index]?.label).toBe(401);
      expect(result.www, cases[index]?.label).toContain("Bearer");
      expect(result.body, cases[index]?.label).toBe('{"error":"unauthorized"}');
    }
    // Nenhuma resposta distingue "token existe mas foi revogado" de "nao existe".
    expect(new Set(observed.map((item) => item.body)).size).toBe(1);
  });

  it("200 com credencial valida: 37 tools, collab_status e collab_create_room", async () => {
    const { app, credentialA } = await startAuthTestApp();
    apps.push(app);

    // RFC 7235: o esquema e case-insensitive; espacos extras sao tolerados.
    const lowercaseScheme = await fetch(app.mcpUrl, {
      method: "POST",
      headers: {
        ...authHeaders(),
        authorization: `bearer   ${credentialA.token}`,
      },
      body: initializeBody(),
    });
    expect(lowercaseScheme.status).toBe(200);

    const health = await fetch(app.healthUrl);
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as { auth: { enabled: boolean } };
    expect(healthBody.auth.enabled).toBe(true);

    const mcp = await connectTestMcpClient(app.mcpUrl, credentialA.token);
    clients.push(mcp);

    const { tools } = await mcp.client.listTools();
    expect(tools).toHaveLength(37);
    expect(tools.map((tool) => tool.name)).toContain(DIAGNOSTICS_TOOL_NAME);

    const status = await mcp.client.callTool({ name: DIAGNOSTICS_TOOL_NAME, arguments: {} });
    expect(status.isError).not.toBe(true);
    const report = status.structuredContent as {
      authEnabled: boolean;
      principalId: string;
      principalName: string;
    };
    expect(report.authEnabled).toBe(true);
    expect(report.principalId).toBe(credentialA.id);
    expect(report.principalName).toBe(credentialA.name);

    const room = await callOk<{ sessionToken: string; room: { workspaceId: string } }>(
      mcp,
      "collab_create_room",
      { displayName: "OpenCode", roomName: "Sala auth", workspaceId: "ws_integration" },
    );
    expect(room.room.workspaceId).toBe("ws_integration");
    expect(room.sessionToken).toMatch(/^collab_s_/);
  });

  it("credencial revogada perde o transporte IMEDIATAMENTE; outra credencial continua", async () => {
    const { app, credentialA, credentialB } = await startAuthTestApp();
    apps.push(app);

    expect((await postMcp(app.mcpUrl, authHeaders(credentialA.token), initializeBody())).status).toBe(200);

    revokePrincipal(app.database, String(credentialA.id));

    const revoked = await postMcp(app.mcpUrl, authHeaders(credentialA.token));
    expect(revoked.status).toBe(401);
    expect(
      (await fetch(app.mcpUrl, {
        method: "GET",
        headers: authHeaders(credentialA.token),
      })).status,
    ).toBe(401);
    expect(
      (await fetch(app.mcpUrl, {
        method: "DELETE",
        headers: authHeaders(credentialA.token),
      })).status,
    ).toBe(401);
    expect((await fetch(app.healthUrl)).status).toBe(200);
    expect((await postMcp(app.mcpUrl, authHeaders(credentialB.token), initializeBody())).status).toBe(200);
  });

  it("403 quando uma SESSAO MCP criada por A e reusada com o Bearer de B", async () => {
    const { app, credentialA, credentialB } = await startAuthTestApp();
    apps.push(app);

    const init = await fetch(app.mcpUrl, {
      method: "POST",
      headers: authHeaders(credentialA.token),
      body: initializeBody(),
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const reused = await fetch(app.mcpUrl, {
      method: "POST",
      headers: {
        ...authHeaders(credentialB.token),
        "mcp-session-id": sessionId ?? "",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(reused.status).toBe(403);
    expect((await reused.json()) as { error: string }).toEqual({ error: "forbidden" });

    for (const method of ["GET", "DELETE"] as const) {
      const crossPrincipal = await fetch(app.mcpUrl, {
        method,
        headers: {
          ...authHeaders(credentialB.token),
          "mcp-session-id": sessionId ?? "",
        },
      });
      expect(crossPrincipal.status, method).toBe(403);
    }

    // O mesmo principal da sessao continua autorizado (DELETE encerra a sessao).
    const own = await fetch(app.mcpUrl, {
      method: "DELETE",
      headers: {
        ...authHeaders(credentialA.token),
        "mcp-session-id": sessionId ?? "",
      },
    });
    expect(own.status).not.toBe(403);
  });
});

describe("Host header, allowedHosts e binding", () => {
  it("Host loopback permitido; host desconhecido negado com 403", async () => {
    const { app } = await startAuthTestApp();
    apps.push(app);
    expect(app.config.host).toBe("127.0.0.1");
    expect(await hostProbe(app.port, app.config.healthPath, "127.0.0.1")).toBe(200);
    expect(await hostProbe(app.port, app.config.healthPath, "localhost")).toBe(200);
    expect(await hostProbe(app.port, app.config.healthPath, "evil.example")).toBe(403);
    expect(await hostProbe(app.port, app.config.mcpPath, "evil.example")).toBe(403);
  });

  it("allowed host configurado explicitamente e aceito; binding continua loopback", async () => {
    const { app } = await startAuthTestApp({
      allowedHosts: ["127.0.0.1", "localhost", "[::1]", "meu-pc.tailnet.ts.net"],
    });
    apps.push(app);
    expect(app.config.host).toBe("127.0.0.1");
    expect(app.config.allowedHosts).toContain("meu-pc.tailnet.ts.net");
    expect(await hostProbe(app.port, app.config.healthPath, "meu-pc.tailnet.ts.net")).toBe(200);
    expect(await hostProbe(app.port, app.config.healthPath, "outro.example")).toBe(403);
  });
});

describe("rate limiting de Bearer invalido", () => {
  it("limita tentativas invalidas, NAO afeta token valido, libera com o tempo e nao loga token", async () => {
    const logger = createCapturingLogger();
    const { app, credentialA } = await startAuthTestApp({
      logger,
      authRateLimit: { maxFailures: 2, windowMs: 60_000, blockMs: 250 },
    });
    apps.push(app);

    const badToken = "invalid-token-for-test";
    expect((await postMcp(app.mcpUrl, authHeaders(badToken))).status).toBe(401);
    expect((await postMcp(app.mcpUrl, authHeaders(badToken))).status).toBe(401);
    const blocked = await postMcp(app.mcpUrl, authHeaders(badToken));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();

    // Token VALIDO nao e afetado pelo bloqueio e limpa o historico da chave.
    const valid = await postMcp(app.mcpUrl, authHeaders(credentialA.token), initializeBody());
    expect(valid.status).toBe(200);

    await new Promise<void>((resolve) => setTimeout(resolve, 320));
    expect((await postMcp(app.mcpUrl, authHeaders(badToken))).status).toBe(401);

    const logText = logger.lines.join("\n");
    expect(logText).not.toContain(badToken);
    expect(logText).not.toContain(credentialA.token);
    expect(logText).not.toContain("Authorization");
  });

  it("limiter unitario: sweep remove entradas expiradas (now injetavel)", () => {
    let clock = 1_000;
    const limiter = createAuthRateLimiter({
      limits: { maxFailures: 2, windowMs: 1_000, blockMs: 1_000 },
      now: () => clock,
      sweepIntervalMs: 0,
    });
    limiter.recordFailure("ip", clock);
    limiter.recordFailure("ip", clock);
    expect(limiter.check("ip", clock).allowed).toBe(false);
    limiter.recordSuccess("ip");
    expect(limiter.check("ip", clock).allowed).toBe(true);
    limiter.recordFailure("ip", clock);
    limiter.recordFailure("ip", clock);
    clock += 5_000;
    limiter.sweep(clock);
    expect(limiter.check("ip", clock).allowed).toBe(true);
    limiter.dispose();
  });
});

describe("todas as rotas MCP e fundacao isolada", () => {
  it("GET e DELETE /mcp tambem exigem Bearer (401), enquanto /health e publico", async () => {
    const { app } = await startAuthTestApp();
    apps.push(app);

    for (const method of ["POST", "GET", "DELETE"] as const) {
      const response = await fetch(app.mcpUrl, { method, headers: authHeaders() });
      expect(response.status, method).toBe(401);
      expect(response.headers.get("www-authenticate"), method).toContain("Bearer");
    }
    expect((await fetch(app.healthUrl)).status).toBe(200);
  });

  it("/health e publico mesmo com Bearer invalido; nao ha CORS liberado", async () => {
    const { app } = await startAuthTestApp();
    apps.push(app);

    const health = await fetch(app.healthUrl, {
      headers: { Authorization: "Bearer invalido" },
    });
    expect(health.status).toBe(200);
    expect(health.headers.get("access-control-allow-origin")).toBeNull();

    const preflight = await fetch(app.mcpUrl, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example" },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();

    const getWithNoBearer = await fetch(app.mcpUrl, {
      method: "GET",
      headers: authHeaders(),
    });
    expect(getWithNoBearer.status).toBe(401);
    expect(getWithNoBearer.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("auth required funciona em DB sem colaboracao (migration 030 condicional)", async () => {
    const dir = createTestDir("auth-foundation-only");
    const config: ServerConfig = {
      ...loadConfig({}, dir),
      port: 0,
      dbPath: path.join(dir, "foundation.sqlite"),
    };
    const running = await startServer({ config, logger: createCapturingLogger() });
    servers.push(running);

    expect(running.authEnabled).toBe(true);
    expect(running.migrationResult.applied.map((m) => m.version)).toEqual([1, 30]);
    expect(running.migrationResult.currentVersion).toBe(30);

    const credential = issueTestCredential(running.database, "fundacao-only");
    const mcp = await connectTestMcpClient(running.mcpUrl, credential.token);
    clients.push(mcp);
    const { tools } = await mcp.client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([DIAGNOSTICS_TOOL_NAME]);
    expect(
      (await mcp.client.callTool({ name: DIAGNOSTICS_TOOL_NAME, arguments: {} })).isError,
    ).not.toBe(true);
    expect((await fetch(running.mcpUrl, { method: "GET" })).status).toBe(401);
  });
});

describe("nao vazamento de segredos", () => {
  it("token/hash nao aparecem em DB, health, audit, respostas ou logs", async () => {
    const logger = createCapturingLogger();
    const { app, credentialA } = await startAuthTestApp({ logger });
    apps.push(app);

    const mcp = await connectTestMcpClient(app.mcpUrl, credentialA.token);
    clients.push(mcp);
    await callOk(mcp, "collab_create_room", {
      displayName: "OpenCode",
      roomName: "Sala sem vazamento",
      workspaceId: "ws_integration",
    });
    const statusText = JSON.stringify(
      await mcp.client.callTool({ name: DIAGNOSTICS_TOOL_NAME, arguments: {} }),
    );

    const hashHex = createHash("sha256").update(credentialA.token, "utf8").digest("hex");
    const dbBytes = readFileSync(app.config.dbPath);
    expect(dbBytes.includes(Buffer.from(credentialA.token, "utf8"))).toBe(false);
    expect(dbBytes.includes(Buffer.from(hashHex, "utf8"))).toBe(true); // somente o hash

    const healthText = await (await fetch(app.healthUrl)).text();
    const auditText = JSON.stringify(
      app.database.prepare("SELECT * FROM collab_audit_log").all(),
    );
    const principalsText = JSON.stringify(
      app.database.prepare("SELECT * FROM transport_principals").all(),
    );
    const logText = logger.lines.join("\n");

    for (const text of [healthText, auditText, statusText, principalsText, logText]) {
      expect(text).not.toContain(credentialA.token);
    }
    expect(healthText).not.toContain(hashHex);
    expect(auditText).not.toContain(hashHex);
    expect(statusText).not.toContain(hashHex);
    expect(logText).not.toContain(hashHex);
    expect(logText).not.toContain("Bearer ");
  });
});
