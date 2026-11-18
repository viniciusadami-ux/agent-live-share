import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { authenticateCollaborationSession } from "../collaboration/index.js";
import type { ToolModule } from "../server/composition.js";
import type { WorkspaceRuntime } from "./runtime.js";
import { resolveAuthorizedRoot } from "./paths.js";
import {
  createFile,
  applyPatch,
  restoreVersion,
  type ApplyPatchInput,
  type CreateFileInput,
  type RestoreVersionInput,
} from "./mutations.js";
import {
  listFiles,
  readFile,
  searchFiles,
} from "./files.js";
import { fileHistory } from "./versions.js";
import {
  beginCheckpoint,
  checkpointStatus,
  endCheckpoint,
} from "./checkpoints.js";
import {
  failure,
  lockIdSchema,
  pathSchema,
  success,
  successOutputSchema,
  tokenSchema,
  withActor,
} from "./toolSupport.js";
import type { PatchReplacement } from "./types.js";

export const WORKSPACE_TOOL_NAMES = [
  "collab_list_workspaces",
  "collab_list_files",
  "collab_read_file",
  "collab_search_files",
  "collab_apply_patch",
  "collab_create_file",
  "collab_file_history",
  "collab_restore_version",
] as const;

export const CHECKPOINT_TOOL_NAMES = [
  "collab_checkpoint_begin",
  "collab_checkpoint_end",
  "collab_checkpoint_status",
] as const;

const replacementSchema = z.object({
  oldText: z.string().min(1).max(200_000),
  newText: z.string().max(200_000),
  expectedOccurrences: z.number().int().min(1).optional(),
});

const annotations = (readOnly: boolean, destructive: boolean) => ({
  readOnlyHint: readOnly,
  destructiveHint: destructive,
  idempotentHint: readOnly,
  openWorldHint: false,
});

/**
 * Registra as tools de leitura/escrita de workspace.
 * Nenhuma resposta contem rootPath, caminho absoluto do host ou token.
 */
export function workspaceToolModule(runtime: WorkspaceRuntime): ToolModule {
  return (server: McpServer): void => {
    server.registerTool(
      "collab_list_workspaces",
      {
        title: "Listar workspaces permitidos",
        description:
          "Lista SOMENTE id/name dos workspaces AUTORIZADOS ao principal autenticado. " +
          "Pode ser chamada ANTES de ter uma sessao de sala: o Bearer de transporte e a unica " +
          "credencial necessaria. Se `token` for enviado, ele tambem e validado (compatibilidade). " +
          "Nunca retorna rootPath, caminho do host, lista de principals ou workspaces nao autorizados.",
        inputSchema: { token: tokenSchema.optional() },
        outputSchema: successOutputSchema("collab_list_workspaces"),
        annotations: annotations(true, false),
      },
      async (args): Promise<CallToolResult> => {
        const tool = "collab_list_workspaces";
        try {
          // Descoberta ANTES da primeira sala: o principal ja foi autenticado
          // pelo middleware Bearer. Quando um token de sala e enviado, ele
          // continua sendo validado para nao aceitar credencial invalida.
          if (args.token !== undefined) {
            const actor = authenticateCollaborationSession(runtime.db, args.token, {
              now: runtime.now,
              principalId: runtime.principalId,
            });
            resolveAuthorizedRoot(
              runtime.catalog,
              actor.room.workspaceId,
              runtime.principalId,
            );
          }
          return success(tool, {
            workspaces: runtime.catalog.listSafeForPrincipal(runtime.principalId),
          });
        } catch (error) {
          return failure(tool, error);
        }
      },
    );

    server.registerTool(
      "collab_list_files",
      {
        title: "Listar arquivos do workspace",
        description:
          "Lista arquivos/diretorios relativos ao workspace da sala, com paginacao (offset/limit) e profundidade maxima. " +
          "Ignora .git, node_modules, bancos SQLite e temporarios internos. Nao segue symlinks/junctions.",
        inputSchema: {
          token: tokenSchema,
          path: pathSchema.optional(),
          offset: z.number().int().min(0).optional(),
          limit: z.number().int().min(1).max(500).optional(),
          depth: z.number().int().min(0).max(32).optional(),
        },
        outputSchema: successOutputSchema("collab_list_files"),
        annotations: annotations(true, false),
      },
      (args): Promise<CallToolResult> =>
        withActor(
          runtime,
          "collab_list_files",
          args.token,
          (actor) => ({
            ...listFiles(runtime, actor, {
              path: args.path,
              offset: args.offset,
              limit: args.limit,
              depth: args.depth,
            }),
          }),
          { audit: false },
        ),
    );

    server.registerTool(
      "collab_read_file",
      {
        title: "Ler arquivo",
        description:
          "Le um arquivo de TEXTO UTF-8 e retorna caminho relativo normalizado, conteudo, SHA-256 (hash) e versao. " +
          "Leitura NAO exige lock. Use o hash retornado como expectedHash em collab_apply_patch. " +
          "Rejeita binarios e arquivos acima de maxFileBytes.",
        inputSchema: { token: tokenSchema, path: pathSchema },
        outputSchema: successOutputSchema("collab_read_file"),
        annotations: annotations(true, false),
      },
      (args): Promise<CallToolResult> =>
        withActor(
          runtime,
          "collab_read_file",
          args.token,
          (actor) => ({ ...readFile(runtime, actor, { path: args.path }) }),
          { audit: false },
        ),
    );

    server.registerTool(
      "collab_search_files",
      {
        title: "Pesquisar arquivos",
        description:
          "Busca por nome e/ou conteudo (substring, case-insensitive) com limites de varredura/resultados. " +
          "Ignora binarios, arquivos grandes e pastas irrelevantes. Retorna caminhos relativos e trechos de linha.",
        inputSchema: {
          token: tokenSchema,
          query: z.string().min(1).max(500),
          mode: z.enum(["name", "content", "both"]).optional(),
          path: pathSchema.optional(),
          limit: z.number().int().min(1).max(100).optional(),
        },
        outputSchema: successOutputSchema("collab_search_files"),
        annotations: annotations(true, false),
      },
      (args): Promise<CallToolResult> =>
        withActor(
          runtime,
          "collab_search_files",
          args.token,
          (actor) => ({
            ...searchFiles(runtime, actor, {
              query: args.query,
              mode: args.mode,
              path: args.path,
              limit: args.limit,
            }),
          }),
          { audit: false },
        ),
    );

    server.registerTool(
      "collab_apply_patch",
      {
        title: "Aplicar patch delimitado",
        description:
          "Aplica substituicoes EXATAS {oldText,newText,expectedOccurrences?} atomicamente. " +
          "Rejeita zero/multiplas ocorrencias inesperadas e sobreposicao ambigua. " +
          "EXIGE lockId valido (mesma sessao/agente/arquivo), expectedHash da leitura atual e nenhum checkpoint ativo. " +
          "Grava backup + nova versao; nunca reescreve o arquivo inteiro como unico mecanismo.",
        inputSchema: {
          token: tokenSchema,
          path: pathSchema,
          lockId: lockIdSchema,
          expectedHash: z.string().regex(/^[0-9a-f]{64}$/),
          replacements: z.array(replacementSchema).min(1).max(50),
          note: z.string().max(2000).optional(),
        },
        outputSchema: successOutputSchema("collab_apply_patch"),
        annotations: annotations(false, true),
      },
      (args): Promise<CallToolResult> =>
        withActor(runtime, "collab_apply_patch", args.token, (actor) => {
          const input: ApplyPatchInput = {
            path: args.path,
            lockId: args.lockId,
            expectedHash: args.expectedHash,
            replacements: args.replacements as readonly PatchReplacement[],
            note: args.note,
          };
          return { ...applyPatch(runtime, actor, input) };
        }),
    );

    server.registerTool(
      "collab_create_file",
      {
        title: "Criar arquivo novo",
        description:
          "Cria um arquivo de texto com base AUSENTE (o caminho nao pode existir). Exige lockId valido e nenhum checkpoint ativo. " +
          "Registra a ausencia anterior como versao de backup e publica a nova versao. Diretorios novos nao sao criados no MVP.",
        inputSchema: {
          token: tokenSchema,
          path: pathSchema,
          lockId: lockIdSchema,
          content: z.string().max(2_000_000),
          note: z.string().max(2000).optional(),
        },
        outputSchema: successOutputSchema("collab_create_file"),
        annotations: annotations(false, true),
      },
      (args): Promise<CallToolResult> =>
        withActor(runtime, "collab_create_file", args.token, (actor) => {
          const input: CreateFileInput = {
            path: args.path,
            lockId: args.lockId,
            content: args.content,
            note: args.note,
          };
          return { ...createFile(runtime, actor, input) };
        }),
    );

    server.registerTool(
      "collab_file_history",
      {
        title: "Historico de versoes",
        description:
          "Lista versoes registradas de um arquivo (sem conteudo): numero, hash, tamanho, tipo, autor e data. " +
          "O historico nunca e apagado; restaurar publica uma NOVA versao.",
        inputSchema: {
          token: tokenSchema,
          path: pathSchema,
          limit: z.number().int().min(1).max(100).optional(),
        },
        outputSchema: successOutputSchema("collab_file_history"),
        annotations: annotations(true, false),
      },
      (args): Promise<CallToolResult> =>
        withActor(
          runtime,
          "collab_file_history",
          args.token,
          (actor) => ({
            ...fileHistory(runtime, actor.room.workspaceId, {
              path: args.path,
              limit: args.limit,
            }),
          }),
          { audit: false },
        ),
    );

    server.registerTool(
      "collab_restore_version",
      {
        title: "Restaurar versao",
        description:
          "Restaura o CONTEUDO de uma versao anterior como uma NOVA versao (nao apaga historico). " +
          "Exige lockId valido, expectedHash da leitura atual e nenhum checkpoint ativo. Nao restaura estado 'ausente' (delete fora do MVP).",
        inputSchema: {
          token: tokenSchema,
          path: pathSchema,
          lockId: lockIdSchema,
          expectedHash: z.string().regex(/^[0-9a-f]{64}$/),
          version: z.number().int().min(1),
          note: z.string().max(2000).optional(),
        },
        outputSchema: successOutputSchema("collab_restore_version"),
        annotations: annotations(false, true),
      },
      (args): Promise<CallToolResult> =>
        withActor(runtime, "collab_restore_version", args.token, (actor) => {
          const input: RestoreVersionInput = {
            path: args.path,
            lockId: args.lockId,
            expectedHash: args.expectedHash,
            version: args.version,
            note: args.note,
          };
          return { ...restoreVersion(runtime, actor, input) };
        }),
    );
  };
}

/**
 * Checkpoints globais: somente coordinator da sala autorizada inicia/encerra;
 * mutacoes ficam pausadas enquanto houver checkpoint aberto no workspace.
 */
export function checkpointToolModule(runtime: WorkspaceRuntime): ToolModule {
  return (server: McpServer): void => {
    server.registerTool(
      "collab_checkpoint_begin",
      {
        title: "Iniciar checkpoint",
        description:
          "Coordinator inicia um checkpoint global no workspace da sala. Exige NENHUM lock ativo no workspace. " +
          "Enquanto aberto, TODAS as mutacoes (patch/create/restore) sao pausadas. Registra nota/resultados de testes opcionais. " +
          "Nao executa Git nem shell.",
        inputSchema: {
          token: tokenSchema,
          note: z.string().max(4000).optional(),
          testResults: z.record(z.string(), z.unknown()).optional(),
        },
        outputSchema: successOutputSchema("collab_checkpoint_begin"),
        annotations: annotations(false, false),
      },
      (args): Promise<CallToolResult> =>
        withActor(runtime, "collab_checkpoint_begin", args.token, (actor) => ({
          checkpoint: beginCheckpoint(runtime, actor, {
            note: args.note,
            testResults: args.testResults,
          }),
        })),
    );

    server.registerTool(
      "collab_checkpoint_end",
      {
        title: "Encerrar checkpoint",
        description:
          "Qualquer coordinator ATUAL de sala no mesmo workspace pode encerrar o checkpoint aberto (regra anti-deadlock). " +
          "Registra sealedAt, sealed_by, nota e resultados de testes finais; a criacao permanece em created_by. " +
          "Apos o encerramento, as mutacoes voltam a ser permitidas.",
        inputSchema: {
          token: tokenSchema,
          note: z.string().max(4000).optional(),
          testResults: z.record(z.string(), z.unknown()).optional(),
        },
        outputSchema: successOutputSchema("collab_checkpoint_end"),
        annotations: annotations(false, false),
      },
      (args): Promise<CallToolResult> =>
        withActor(runtime, "collab_checkpoint_end", args.token, (actor) => ({
          checkpoint: endCheckpoint(runtime, actor, {
            note: args.note,
            testResults: args.testResults,
          }),
        })),
    );

    server.registerTool(
      "collab_checkpoint_status",
      {
        title: "Estado do checkpoint",
        description:
          "Mostra se o workspace esta pausado por checkpoint, o checkpoint atual/ultimo e a contagem de locks ativos.",
        inputSchema: { token: tokenSchema },
        outputSchema: successOutputSchema("collab_checkpoint_status"),
        annotations: annotations(true, false),
      },
      (args): Promise<CallToolResult> =>
        withActor(
          runtime,
          "collab_checkpoint_status",
          args.token,
          (actor) => ({ ...checkpointStatus(runtime, actor) }),
          { audit: false },
        ),
    );
  };
}
