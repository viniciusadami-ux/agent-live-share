import type { Logger } from "../config/logger.js";
import type { RunningServer } from "./httpServer.js";

/**
 * Graceful shutdown para SIGINT (Ctrl+C) e SIGTERM.
 * Fecha transports MCP, listener HTTP e SQLite, nessa ordem.
 * Retorna uma funcao para remover os handlers (usada em testes/integracao).
 */
export function installGracefulShutdown(running: RunningServer, logger: Logger): () => void {
  let inProgress = false;

  const onSignal = (signal: string): void => {
    if (inProgress) return;
    inProgress = true;
    logger.info(`Sinal ${signal} recebido; encerrando...`);
    void (async () => {
      try {
        await running.close();
        logger.info("Encerramento concluido.");
        process.exit(0);
      } catch (error) {
        logger.error(
          `Falha no encerramento: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    })();
  };

  const onSigint = (): void => onSignal("SIGINT");
  const onSigterm = (): void => onSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
}
