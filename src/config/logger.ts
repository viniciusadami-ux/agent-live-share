import type { LogLevel } from "./env.js";

/** Logger minimo da fundacao. Nunca loga corpo de mensagem nem conteudo de arquivo. */
export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level: LogLevel): Logger {
  const threshold = ORDER[level];
  const emit = (targetLevel: LogLevel, prefix: string, message: string): void => {
    if (ORDER[targetLevel] < threshold) return;
    const line = `[collab-mcp] ${prefix} ${message}`;
    if (targetLevel === "error" || targetLevel === "warn") {
      console.error(line);
    } else {
      console.log(line);
    }
  };
  return {
    debug: (message) => emit("debug", "DEBUG", message),
    info: (message) => emit("info", "INFO ", message),
    warn: (message) => emit("warn", "WARN ", message),
    error: (message) => emit("error", "ERROR", message),
  };
}

export function createSilentLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}
