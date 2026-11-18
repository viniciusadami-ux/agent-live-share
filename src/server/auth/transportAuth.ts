import { isIP } from "node:net";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { TrustedProxyConfig } from "../../config/env.js";
import type { Logger } from "../../config/logger.js";
import type { AuthenticatedPrincipal } from "../../contracts/index.js";
import type { DatabaseConnection } from "../../persistence/index.js";
import { runWithPrincipal } from "./principalContext.js";
import { authenticateTransportToken } from "./principals.js";
import type { AuthRateLimiter } from "./rateLimit.js";

/**
 * Middleware de autenticacao/autorizacao do TRANSPORTE HTTP.
 *
 * Aplicado SOMENTE as rotas `/mcp` (POST/GET/DELETE). `/health` continua
 * publico e sem dados sensiveis.
 *
 * Respostas:
 * - 401 `WWW-Authenticate: Bearer` para header ausente, formato invalido,
 *   token inexistente ou revogado. O corpo e IDENTICO em todos os casos:
 *   nunca revela se o token existe.
 * - 429 quando a chave (endereco do par) excedeu tentativas invalidas.
 * - 403 fica a cargo do `httpApp` quando uma identidade VALIDA tenta usar
 *   uma sessao MCP criada por outro principal.
 *
 * Identidade propagada de tres formas complementares:
 * 1. `req.auth` no shape `AuthInfo` do SDK (recurso oficial: vira
 *    `extra.authInfo` nos handlers), com o token REDIGIDO.
 * 2. `AsyncLocalStorage` (`runWithPrincipal`) para todo o async context.
 * 3. Simbolo no `req` lido pelo `httpApp`, que captura o principal na
 *    SESSAO MCP (autoridade primaria, independente de async context).
 */

export const REQUEST_PRINCIPAL_KEY = Symbol("collab.authenticatedPrincipal");

type RequestWithPrincipal = Request & {
  [REQUEST_PRINCIPAL_KEY]?: AuthenticatedPrincipal;
};

/** Shape de `AuthInfo` (@modelcontextprotocol/sdk/server/auth/types.js). */
interface SdkAuthInfo {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt?: number;
}

type RequestWithAuth = Request & { auth?: SdkAuthInfo };

export function setRequestPrincipal(req: Request, principal: AuthenticatedPrincipal): void {
  (req as RequestWithPrincipal)[REQUEST_PRINCIPAL_KEY] = principal;
}

export function getRequestPrincipal(req: Request): AuthenticatedPrincipal | undefined {
  return (req as RequestWithPrincipal)[REQUEST_PRINCIPAL_KEY];
}

export type TransportAuthConfig =
  | { readonly mode: "required" }
  | {
      /** Marcado EXPLICITAMENTE para testes da fundacao; nunca usado pela aplicacao. */
      readonly mode: "disabled-for-tests";
    };

export interface TransportAuthMiddlewareOptions {
  readonly db: DatabaseConnection;
  readonly rateLimiter: AuthRateLimiter;
  readonly trustedProxy: TrustedProxyConfig;
  readonly logger: Logger;
}

/** Extrai Bearer rigorosamente; nao aceita Basic, multiplos tokens ou vazio. */
export function bearerTokenOf(req: Request): string | undefined {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return undefined;
  const match = /^Bearer +([^\s]+)$/i.exec(header.trim());
  return match?.[1];
}

function normalizeIp(value: string): string {
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}

/**
 * Chave do rate limiter. NUNCA usa o token. So confia em `X-Forwarded-For`
 * quando `trustedProxy.enabled` for true E o par remoto estiver allowlisted.
 */
export function clientAddressOf(req: Request, trustedProxy: TrustedProxyConfig): string {
  const remote = req.socket.remoteAddress ?? "unknown";
  if (!trustedProxy.enabled) return normalizeIp(remote);
  if (!trustedProxy.proxyAddresses.includes(normalizeIp(remote))) {
    return normalizeIp(remote);
  }
  const forwarded = req.headers["x-forwarded-for"];
  const raw =
    typeof forwarded === "string"
      ? forwarded.split(",")[0]
      : Array.isArray(forwarded)
        ? forwarded[0]?.split(",")[0]
        : undefined;
  const candidate = raw?.trim() ?? "";
  // Nao aceitamos texto arbitrario como chave de rate limit: apenas um IP
  // literal. Se o proxy enviar porta/lixo, caimos no par remoto (fail-safe).
  if (candidate.length === 0 || candidate.length > 64 || isIP(candidate) === 0) {
    return normalizeIp(remote);
  }
  return normalizeIp(candidate);
}

export function createTransportAuthMiddleware(
  options: TransportAuthMiddlewareOptions,
): RequestHandler {
  const { db, rateLimiter, trustedProxy, logger } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = clientAddressOf(req, trustedProxy);
    const nowMs = Date.now();
    const token = bearerTokenOf(req);
    const principal =
      token === undefined ? undefined : authenticateTransportToken(db, token);

    // Um token VALIDO nunca e afetado pelo bloqueio da chave e ainda limpa o
    // historico de falhas. O limite incide somente sobre tentativas invalidas.
    if (principal === undefined) {
      const decision = rateLimiter.check(key, nowMs);
      if (!decision.allowed) {
        res.setHeader("Retry-After", String(decision.retryAfterSeconds ?? 1));
        res.status(429).json({ error: "too_many_requests" });
        return;
      }
      rateLimiter.recordFailure(key, nowMs);
      // Nunca loga o header, o token, o hash ou o motivo especifico.
      logger.warn("Autenticacao de transporte recusada (credencial invalida).");
      res.setHeader("WWW-Authenticate", 'Bearer realm="collab-mcp"');
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    rateLimiter.recordSuccess(key);
    setRequestPrincipal(req, principal);
    // `token` e redigido: o SDK repassa AuthInfo aos handlers, mas nenhum
    // segredo deve trafegar alem deste ponto.
    (req as RequestWithAuth).auth = {
      token: "[redacted]",
      clientId: String(principal.id),
      scopes: [],
    };
    logger.debug(
      `Transporte autenticado: principalId=${principal.id} name=${principal.name}`,
    );

    runWithPrincipal(principal, () => next());
  };
}
