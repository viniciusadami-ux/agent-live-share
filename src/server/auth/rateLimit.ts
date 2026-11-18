import type { AuthRateLimitConfig } from "../../config/env.js";

/**
 * Rate limiting SIMPLES e testavel para tentativas Bearer invalidas.
 *
 * - Estado somente em MEMORIA, por ENDERECO DO PAR (nunca pelo token).
 * - So contabiliza FALHAS; um token valido RESETA o contador da chave.
 * - Janela deslizante + bloqueio temporario + limpeza periodica (sweep).
 * - `now` injetavel para testes deterministicos de tempo.
 *
 * Atras de proxy, a chave so usa IP encaminhado quando a configuracao de
 * proxy confiavel estiver explicitamente habilitada (ver transportAuth.ts).
 */

interface Bucket {
  failures: number;
  windowStart: number;
  blockedUntil: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds?: number;
}

export interface AuthRateLimiter {
  check(key: string, nowMs: number): RateLimitDecision;
  recordFailure(key: string, nowMs: number): void;
  /** Sucesso nao e penalizado: remove qualquer historico da chave. */
  recordSuccess(key: string): void;
  sweep(nowMs: number): void;
  dispose(): void;
}

export interface CreateAuthRateLimiterOptions {
  readonly limits: AuthRateLimitConfig;
  readonly now?: () => number;
  /** Intervalo de limpeza em ms; 0 desliga o timer (testes). */
  readonly sweepIntervalMs?: number;
}

export function createAuthRateLimiter(
  options: CreateAuthRateLimiterOptions,
): AuthRateLimiter {
  const { limits } = options;
  const now = options.now ?? ((): number => Date.now());
  const buckets = new Map<string, Bucket>();
  const sweepIntervalMs = options.sweepIntervalMs ?? 30_000;

  const timer =
    sweepIntervalMs > 0
      ? setInterval(() => {
          sweepImpl(now());
        }, sweepIntervalMs)
      : undefined;
  timer?.unref();

  function sweepImpl(nowMs: number): void {
    for (const [key, bucket] of buckets) {
      const windowExpired = nowMs - bucket.windowStart >= limits.windowMs;
      const blockExpired = bucket.blockedUntil <= nowMs;
      if (windowExpired && blockExpired) buckets.delete(key);
    }
  }

  return {
    check(key, nowMs): RateLimitDecision {
      const bucket = buckets.get(key);
      if (bucket === undefined) return { allowed: true };
      if (bucket.blockedUntil > nowMs) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((bucket.blockedUntil - nowMs) / 1000)),
        };
      }
      if (nowMs - bucket.windowStart >= limits.windowMs) {
        buckets.delete(key);
        return { allowed: true };
      }
      return { allowed: true };
    },
    recordFailure(key, nowMs): void {
      let bucket = buckets.get(key);
      if (bucket === undefined || nowMs - bucket.windowStart >= limits.windowMs) {
        bucket = { failures: 0, windowStart: nowMs, blockedUntil: 0 };
        buckets.set(key, bucket);
      }
      bucket.failures += 1;
      if (bucket.failures >= limits.maxFailures) {
        bucket.blockedUntil = nowMs + limits.blockMs;
      }
      // Pequena limpeza oportunista para nao crescer indefinidamente.
      if (buckets.size > 10_000) sweepImpl(nowMs);
    },
    recordSuccess(key): void {
      buckets.delete(key);
    },
    sweep: sweepImpl,
    dispose(): void {
      if (timer !== undefined) clearInterval(timer);
      buckets.clear();
    },
  };
}
