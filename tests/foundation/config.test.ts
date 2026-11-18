import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_DB_PATH,
  DEFAULT_HOST,
  DEFAULT_PORT,
  LOOPBACK_HOSTS,
  MCP_PATH,
  HEALTH_PATH,
  loadConfig,
} from "../../src/config/env.js";

const CWD = process.cwd();

describe("loadConfig — defaults seguros", () => {
  it("binding padrao e exclusivamente loopback, com auth de transporte habilitada", () => {
    const config = loadConfig({}, CWD);
    expect(config.host).toBe(DEFAULT_HOST);
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.mcpPath).toBe(MCP_PATH);
    expect(config.healthPath).toBe(HEALTH_PATH);
    expect(config.logLevel).toBe("info");
    expect(config.serverName).toBe("collab-mcp");
  });

  it("resolve COLLAB_DB_PATH relativo ao cwd para um caminho absoluto", () => {
    const config = loadConfig({}, CWD);
    expect(config.dbPath).toBe(path.resolve(CWD, DEFAULT_DB_PATH));
    expect(path.isAbsolute(config.dbPath)).toBe(true);
  });

  it.each(LOOPBACK_HOSTS)("aceita host loopback %s", (host) => {
    expect(loadConfig({ COLLAB_HOST: host }, CWD).host).toBe(host);
  });

  it.each(["0.0.0.0", "::", "192.168.0.10", "example.com"])(
    "REJEITA host nao-loopback %s (nao expor rede publica)",
    (host) => {
      expect(() => loadConfig({ COLLAB_HOST: host }, CWD)).toThrow(ConfigError);
      expect(() => loadConfig({ COLLAB_HOST: host }, CWD)).toThrow(/loopback/);
    },
  );

  it("aceita porta 0 (efemera, usada pelos testes)", () => {
    expect(loadConfig({ COLLAB_PORT: "0" }, CWD).port).toBe(0);
  });

  it.each(["abc", "-1", "70000", "3.5"])("rejeita porta invalida %j", (port) => {
    expect(() => loadConfig({ COLLAB_PORT: port }, CWD)).toThrow(ConfigError);
  });

  it("rejeita nivel de log desconhecido", () => {
    expect(() => loadConfig({ COLLAB_LOG_LEVEL: "trace" }, CWD)).toThrow(ConfigError);
  });

  it("aceita COLLAB_DB_PATH customizado", () => {
    const config = loadConfig({ COLLAB_DB_PATH: "./custom/state.sqlite" }, CWD);
    expect(config.dbPath).toBe(path.join(CWD, "custom", "state.sqlite"));
  });
});

describe("loadConfig — allowedHosts, proxy confiavel e rate limiting", () => {
  it("allowedHosts default e somente loopback (sem wildcard)", () => {
    const config = loadConfig({}, CWD);
    expect(config.allowedHosts).toEqual(["127.0.0.1", "localhost", "[::1]"]);
    expect(config.allowedHosts.some((host) => host.includes("*"))).toBe(false);
  });

  it("aceita hosts extras explicitos e remove duplicatas", () => {
    const config = loadConfig(
      { COLLAB_ALLOWED_HOSTS: "127.0.0.1,localhost,meu-pc.tailnet.ts.net,127.0.0.1" },
      CWD,
    );
    expect(config.allowedHosts).toEqual([
      "127.0.0.1",
      "localhost",
      "meu-pc.tailnet.ts.net",
    ]);
  });

  it.each(["*", "*.example.com", "host/path", "host:8080", "a b"])(
    "REJEITA allowed host inseguro %j",
    (value) => {
      expect(() => loadConfig({ COLLAB_ALLOWED_HOSTS: value }, CWD)).toThrow(ConfigError);
    },
  );

  it("normaliza allowed host para lowercase (o SDK compara hostname canonico)", () => {
    const config = loadConfig(
      { COLLAB_ALLOWED_HOSTS: "127.0.0.1,MEU-PC.Tailnet.TS.net" },
      CWD,
    );
    expect(config.allowedHosts).toContain("meu-pc.tailnet.ts.net");
    expect(config.allowedHosts).not.toContain("MEU-PC.Tailnet.TS.net");
  });

  it("proxy confiavel DESABILITADO por padrao", () => {
    const config = loadConfig({}, CWD);
    expect(config.trustedProxy.enabled).toBe(false);
    expect(config.trustedProxy.proxyAddresses).toContain("127.0.0.1");
  });

  it("habilita proxy apenas com valor explicito", () => {
    expect(loadConfig({ COLLAB_TRUST_PROXY: "1" }, CWD).trustedProxy.enabled).toBe(true);
    expect(loadConfig({ COLLAB_TRUST_PROXY: "true" }, CWD).trustedProxy.enabled).toBe(true);
    expect(loadConfig({ COLLAB_TRUST_PROXY: "0" }, CWD).trustedProxy.enabled).toBe(false);
    expect(() => loadConfig({ COLLAB_TRUST_PROXY: "talvez" }, CWD)).toThrow(ConfigError);
  });

  it("rate limiting tem defaults e aceita override numerico", () => {
    const defaults = loadConfig({}, CWD).authRateLimit;
    expect(defaults.maxFailures).toBeGreaterThan(0);
    expect(defaults.windowMs).toBeGreaterThan(0);
    expect(defaults.blockMs).toBeGreaterThan(0);

    const overridden = loadConfig(
      { COLLAB_AUTH_MAX_FAILURES: "2", COLLAB_AUTH_WINDOW_MS: "1000", COLLAB_AUTH_BLOCK_MS: "2000" },
      CWD,
    ).authRateLimit;
    expect(overridden).toEqual({ maxFailures: 2, windowMs: 1000, blockMs: 2000 });
    expect(() => loadConfig({ COLLAB_AUTH_MAX_FAILURES: "0" }, CWD)).toThrow(ConfigError);
  });
});
