import { startApplication, type RunningApplication } from "../../src/application.js";
import {
  loadConfig,
  type AuthRateLimitConfig,
  type ServerConfig,
} from "../../src/config/env.js";
import { createSilentLogger, type Logger } from "../../src/config/logger.js";
import {
  createIntegrationFixture,
  credentialOf,
  type IntegrationFixture,
} from "../integration/helpers/app.js";
import type { TestCredential } from "../helpers/auth.js";
import { cleanupTestRoot } from "../foundation/helpers/tmp.js";

export { cleanupTestRoot };

export interface CapturingLogger extends Logger {
  readonly lines: readonly string[];
}

export function createCapturingLogger(): CapturingLogger {
  const lines: string[] = [];
  const push = (message: string): void => {
    lines.push(message);
  };
  return {
    lines,
    debug: push,
    info: push,
    warn: push,
    error: push,
  };
}

export interface AuthTestApp {
  readonly app: RunningApplication;
  readonly fixture: IntegrationFixture;
  readonly credentialA: TestCredential;
  readonly credentialB: TestCredential;
  readonly logger: CapturingLogger;
}

export interface StartAuthTestAppOptions {
  readonly allowedHosts?: readonly string[];
  readonly authRateLimit?: AuthRateLimitConfig;
  readonly logger?: CapturingLogger;
}

/** Sobe a aplicacao REAL (auth obrigatoria) com dois principals de teste. */
export async function startAuthTestApp(
  options: StartAuthTestAppOptions = {},
): Promise<AuthTestApp> {
  const fixture = createIntegrationFixture();
  const base: ServerConfig = loadConfig({}, fixture.dir);
  const config: ServerConfig = {
    ...base,
    port: 0,
    dbPath: fixture.dbPath,
    ...(options.allowedHosts === undefined ? {} : { allowedHosts: options.allowedHosts }),
  };
  const logger = options.logger ?? createCapturingLogger();

  const app = await startApplication({
    config,
    definitions: fixture.definitions,
    now: fixture.clock.now,
    logger,
    sessionTtlMs: 3_600_000,
    inviteTtlMs: 3_600_000,
    ...(options.authRateLimit === undefined ? {} : { authRateLimit: options.authRateLimit }),
  });

  const credentialA = credentialOf(fixture, 0);
  const credentialB = credentialOf(fixture, 1);
  return { app, fixture, credentialA, credentialB, logger };
}

export function authHeaders(token?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
  };
}

export function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "auth-test", version: "0.1.0" },
    },
  });
}

export function toolsListBody(): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
}
