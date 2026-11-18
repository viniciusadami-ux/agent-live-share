import { startApplication } from "./application.js";
import { loadConfig } from "./config/env.js";
import { createLogger } from "./config/logger.js";
import { installGracefulShutdown } from "./server/lifecycle.js";

/**
 * Entrypoint executavel: `npm run dev` (tsx) ou `npm start` (dist compilado).
 *
 * Sobe a aplicacao INTEGRADA (collaboration + workspace + locking +
 * checkpoints) com autenticacao Bearer OBRIGATORIA no transporte HTTP.
 * O listener continua SOMENTE em loopback; acesso remoto exige Tailscale
 * Serve (ainda nao configurado) alem das credenciais.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const running = await startApplication({ config, logger });
  installGracefulShutdown(running, logger);

  logger.info(`${config.serverName} v${config.serverVersion} em ${running.url}`);
  logger.info(`Endpoint MCP: ${running.mcpUrl}`);
  logger.info(`Health:       ${running.healthUrl}`);
  logger.info(
    `Migrations:   v${running.migrationResult.currentVersion} ` +
      `(${running.migrationResult.totalApplied} aplicadas no total)`,
  );
  logger.info(
    `Workspaces:   ${running.workspaceCount} permitido(s)` +
      (running.workspaceCount === 0 ? " (catalogo vazio)" : ""),
  );
  logger.info(
    `Autenticacao de transporte HABILITADA (Bearer). ` +
      `Hosts permitidos: ${config.allowedHosts.join(", ")}.`,
  );
  if (running.workspaceCount === 0) {
    logger.warn(
      "Catalogo de workspaces vazio: collab_create_room sera recusado ate configurar " +
        "COLLAB_WORKSPACES_FILE (ou workspaces.json).",
    );
  }
  if (running.countActivePrincipals() === 0) {
    logger.warn(
      "Nenhuma credencial de transporte ativa. Crie a primeira com " +
        "`npm run auth:create -- \"Nome / Cliente\"` e configure o Bearer token no cliente MCP.",
    );
  }
  logger.warn(
    `Binding restrito a ${config.host} (loopback). Tailscale/acesso remoto NAO esta configurado; ` +
      "so habilite depois de revisar allowedHosts e proxy confiavel.",
  );
}

main().catch((error: unknown) => {
  console.error(
    "[collab-mcp] Falha fatal ao iniciar:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
