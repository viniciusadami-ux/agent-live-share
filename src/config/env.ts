import { isIP } from "node:net";
import path from "node:path";

/**
 * Configuracao de ambiente da fundacao.
 *
 * Regras de seguranca desta etapa:
 * - O BINDING continua SOMENTE loopback. `0.0.0.0`, `::` ou qualquer host
 *   publico sao REJEITADOS. Acesso externo sera feito por Tailscale Serve
 *   encaminhando para loopback, nunca abrindo o listener.
 * - O transporte HTTP exige Bearer token (implementado em src/server/auth).
 * - `allowedHosts` e a lista EXPLICITA de Host headers aceitos (protecao DNS
 *   rebinding). Nao aceita wildcard. Hosts extras so entram por configuracao.
 * - `X-Forwarded-For` so e considerado quando `COLLAB_TRUST_PROXY` estiver
 *   explicitamente habilitado E o par remoto estiver na allowlist de proxies.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export const SERVER_NAME = "collab-mcp";
export const SERVER_VERSION = "0.1.0";
export const MCP_PATH = "/mcp";
export const HEALTH_PATH = "/health";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3100;
export const DEFAULT_DB_PATH = "./data/collab-mcp.sqlite";

/** Binding: nunca muda sem autenticacao de transporte e revisao de rede. */
export const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "::1"] as const;
/** Hostnames aceitos no Header Host. IPv6 usa colchetes, como no SDK. */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = [
  "127.0.0.1",
  "localhost",
  "[::1]",
] as const;
export const DEFAULT_TRUSTED_PROXY_IPS: readonly string[] = [
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
] as const;

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"] as const;

export interface TrustedProxyConfig {
  readonly enabled: boolean;
  /** Somente pares remotos nesta lista podem fornecer X-Forwarded-For. */
  readonly proxyAddresses: readonly string[];
}

export interface AuthRateLimitConfig {
  readonly maxFailures: number;
  readonly windowMs: number;
  readonly blockMs: number;
}

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly mcpPath: string;
  readonly healthPath: string;
  /** Caminho absoluto do SQLite; fora do repositorio versionado (ver .gitignore). */
  readonly dbPath: string;
  readonly serverName: string;
  readonly serverVersion: string;
  readonly logLevel: LogLevel;
  /** Host headers permitidos (sem porta, sem wildcard). */
  readonly allowedHosts: readonly string[];
  readonly trustedProxy: TrustedProxyConfig;
  readonly authRateLimit: AuthRateLimitConfig;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

function readString(env: EnvSource, key: string, fallback: string): string {
  const raw = env[key];
  return raw === undefined || raw.trim() === "" ? fallback : raw.trim();
}

function readPositiveInt(env: EnvSource, key: string, fallback: number, max: number): number {
  const raw = readString(env, key, String(fallback));
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`${key} invalido: use um inteiro positivo ate ${max}.`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new ConfigError(`${key} fora de intervalo (1..${max}).`);
  }
  return value;
}

function readPort(env: EnvSource): number {
  const raw = readString(env, "COLLAB_PORT", String(DEFAULT_PORT));
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`COLLAB_PORT invalido: "${raw}". Use um inteiro entre 0 e 65535 (0 = porta efemera).`);
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`COLLAB_PORT fora de intervalo: ${port}. Use 0..65535 (0 = porta efemera).`);
  }
  return port;
}

function readHost(env: EnvSource): string {
  const host = readString(env, "COLLAB_HOST", DEFAULT_HOST);
  if (!LOOPBACK_HOSTS.includes(host)) {
    throw new ConfigError(
      `COLLAB_HOST "${host}" nao permitido. ` +
        `O listener aceita apenas loopback: ${LOOPBACK_HOSTS.join(", ")}. ` +
        `Para acesso remoto use Tailscale Serve encaminhando para loopback, nunca binding externo.`,
    );
  }
  return host;
}

function readLogLevel(env: EnvSource): LogLevel {
  const value = readString(env, "COLLAB_LOG_LEVEL", "info");
  if (!LOG_LEVELS.includes(value as LogLevel)) {
    throw new ConfigError(`COLLAB_LOG_LEVEL invalido: "${value}". Use: ${LOG_LEVELS.join(", ")}.`);
  }
  return value as LogLevel;
}

function readCsv(env: EnvSource, key: string): string[] | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** Nunca aceita wildcard, caminho, porta, espaco ou esquema no Host header. */
function readAllowedHosts(env: EnvSource): readonly string[] {
  const entries = readCsv(env, "COLLAB_ALLOWED_HOSTS") ?? [...DEFAULT_ALLOWED_HOSTS];
  if (entries.length === 0 || entries.length > 20) {
    throw new ConfigError("COLLAB_ALLOWED_HOSTS precisa ter entre 1 e 20 hosts.");
  }
  const unique: string[] = [];
  for (const entry of entries) {
    if (entry.length > 253 || entry.includes("*") || /[\s/\\?#@]/.test(entry)) {
      throw new ConfigError(`COLLAB_ALLOWED_HOSTS contem host invalido ou wildcard: "${entry}".`);
    }
    // Valida sintaxe de hostname via URL (aceita "[::1]" e nomes DNS).
    let hostname: string;
    try {
      hostname = new URL(`http://${entry}`).hostname;
    } catch {
      throw new ConfigError(`COLLAB_ALLOWED_HOSTS contem host invalido: "${entry}".`);
    }
    if (hostname !== entry.toLowerCase()) {
      throw new ConfigError(`COLLAB_ALLOWED_HOSTS contem host invalido: "${entry}".`);
    }
    // O SDK compara o hostname (sempre lowercase) contra esta lista. Guardamos a
    // forma canonica lowercase para que um host configurado com maiusculas
    // continue valido (fail-open apenas para a propria config, nunca wildcard).
    if (!unique.includes(hostname)) unique.push(hostname);
  }
  return unique;
}

function readTrustedProxy(env: EnvSource): TrustedProxyConfig {
  const raw = readString(env, "COLLAB_TRUST_PROXY", "false").toLowerCase();
  if (!["0", "1", "false", "true", "no", "yes"].includes(raw)) {
    throw new ConfigError("COLLAB_TRUST_PROXY invalido. Use 0/1, false/true ou no/yes.");
  }
  const enabled = raw === "1" || raw === "true" || raw === "yes";
  const addresses = readCsv(env, "COLLAB_TRUSTED_PROXY_IPS") ?? [
    ...DEFAULT_TRUSTED_PROXY_IPS,
  ];
  if (addresses.length === 0 || addresses.length > 20) {
    throw new ConfigError("COLLAB_TRUSTED_PROXY_IPS precisa ter entre 1 e 20 enderecos.");
  }
  const normalized: string[] = [];
  for (const address of addresses) {
    if (address.length > 64 || isIP(address) === 0) {
      throw new ConfigError("COLLAB_TRUSTED_PROXY_IPS contem endereco IP invalido.");
    }
    // `req.socket.remoteAddress` de IPv4 costuma vir como ::ffff:a.b.c.d;
    // normalizamos a configuracao para que a comparacao seja simetrica.
    const canonical = address.startsWith("::ffff:") ? address.slice(7) : address;
    if (!normalized.includes(canonical)) normalized.push(canonical);
  }
  return { enabled, proxyAddresses: normalized };
}

function readAuthRateLimit(env: EnvSource): AuthRateLimitConfig {
  return {
    maxFailures: readPositiveInt(env, "COLLAB_AUTH_MAX_FAILURES", 5, 1000),
    windowMs: readPositiveInt(env, "COLLAB_AUTH_WINDOW_MS", 60_000, 3_600_000),
    blockMs: readPositiveInt(env, "COLLAB_AUTH_BLOCK_MS", 60_000, 3_600_000),
  };
}

/** Nao le `.env` automaticamente: usa `process.env` (ou `--env-file` nativo do Node). */
export function loadConfig(env: EnvSource = process.env, cwd: string = process.cwd()): ServerConfig {
  const dbPath = readString(env, "COLLAB_DB_PATH", DEFAULT_DB_PATH);
  return {
    host: readHost(env),
    port: readPort(env),
    mcpPath: MCP_PATH,
    healthPath: HEALTH_PATH,
    dbPath: path.resolve(cwd, dbPath),
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    logLevel: readLogLevel(env),
    allowedHosts: readAllowedHosts(env),
    trustedProxy: readTrustedProxy(env),
    authRateLimit: readAuthRateLimit(env),
  };
}
