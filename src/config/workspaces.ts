import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { ConfigError } from "./env.js";
import {
  isPrincipalIdFormat,
  type PrincipalId,
} from "../contracts/index.js";
import type { WorkspaceDefinition } from "../workspace/types.js";

/**
 * Configuracao de workspaces permitidos, SOMENTE no servidor.
 *
 * Formato (arquivo JSON):
 *   { "workspaces": [ {
 *       "id": "migracao", "name": "Migracao", "rootPath": "../sistema",
 *       "allowedPrincipals": ["prin_<uuid>"]
 *   } ] }
 *
 * Regras:
 * - `id` e opaco; nunca aceita caminho (o catalogo valida de novo).
 * - `rootPath` relativo e resolvido a partir do DIRETORIO do arquivo JSON.
 * - `allowedPrincipals` e uma lista EXATA de IDs de principal (`prin_...`),
 *   NUNCA nomes, displayName, tokens Bearer ou curingas. Campo ausente, null
 *   ou [] => NENHUM principal autorizado (FAIL-CLOSED). Itens com formato
 *   invalido ou duplicados derrubam o startup (nao ha wildcard).
 * - Nao validamos a EXISTENCIA da credencial: ela pode ser emitida depois pelo
 *   CLI `auth:create`. Principal revogado continua bloqueado pelo transporte.
 * - O arquivo de configuracao NAO e lido por nenhuma tool MCP; roots e listas
 *   de principals nunca sao aceitos do cliente remoto. Erros nao logam tokens.
 * - Sem `COLLAB_WORKSPACES_FILE` e sem o arquivo padrao, o catalogo sobe VAZIO
 *   (seguro): `collab_create_room` recusa qualquer workspace ate o operador
 *   configurar um root real.
 * - Se `COLLAB_WORKSPACES_FILE` for definido explicitamente e o arquivo nao
 *   existir, o startup falha (erro de configuracao, nao silencio).
 * - Mensagens de erro nao incluem o valor de rootPath.
 */

export const WORKSPACES_FILE_ENV = "COLLAB_WORKSPACES_FILE";
export const DEFAULT_WORKSPACES_FILE = "./workspaces.json";
const MAX_CONFIG_BYTES = 1_000_000;

export interface LoadWorkspaceDefinitionsOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
}

export interface LoadedWorkspaceDefinitions {
  readonly definitions: readonly WorkspaceDefinition[];
  readonly source: "file" | "empty";
  /** Caminho absoluto do arquivo lido (ausente quando source = empty). */
  readonly filePath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entryError(index: number, field: string): ConfigError {
  return new ConfigError(
    `Configuracao de workspaces invalida em workspaces[${index}].${field}.`,
  );
}

function readStringField(entry: Record<string, unknown>, field: string, index: number): string {
  const value = entry[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw entryError(index, field);
  }
  return value.trim();
}

/**
 * Le `allowedPrincipals` de uma entrada. Ausente/null => [] (fail-closed).
 * Formato invalido, item nao-string, curinga ou duplicata => ConfigError.
 * Nunca inclui tokens em mensagens: aqui so existem IDs opacos.
 */
function readAllowedPrincipals(
  entry: Record<string, unknown>,
  index: number,
): readonly PrincipalId[] {
  const raw = entry["allowedPrincipals"];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigError(
      `Configuracao de workspaces invalida em workspaces[${index}].allowedPrincipals: ` +
        'use um array de IDs "prin_..." (campo ausente/vazio = nenhum principal autorizado).',
    );
  }
  const seen = new Set<string>();
  const result: PrincipalId[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !isPrincipalIdFormat(item)) {
      throw new ConfigError(
        `Configuracao de workspaces invalida em workspaces[${index}].allowedPrincipals: ` +
          'PrincipalId invalido. Use apenas IDs opacos "prin_..." (nao nomes, tokens ou curingas).',
      );
    }
    if (seen.has(item)) {
      throw new ConfigError(
        `Configuracao de workspaces invalida em workspaces[${index}].allowedPrincipals: ` +
          "PrincipalId duplicado.",
      );
    }
    seen.add(item);
    result.push(item as PrincipalId);
  }
  return result;
}

function readEntries(parsed: unknown): readonly unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (isRecord(parsed) && Array.isArray(parsed["workspaces"])) {
    return parsed["workspaces"];
  }
  throw new ConfigError(
    'Arquivo de workspaces invalido: use { "workspaces": [ { id, name, rootPath } ] }.',
  );
}

function parseDefinitions(text: string, filePath: string): readonly WorkspaceDefinition[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
  } catch {
    throw new ConfigError("Arquivo de workspaces nao contem JSON valido.");
  }

  const entries = readEntries(parsed);
  const baseDir = path.dirname(filePath);
  const definitions: WorkspaceDefinition[] = [];
  const seen = new Set<string>();

  entries.forEach((value, index) => {
    if (!isRecord(value)) throw entryError(index, "objeto");
    const id = readStringField(value, "id", index);
    const name = readStringField(value, "name", index);
    const rootPathRaw = readStringField(value, "rootPath", index);
    const allowedPrincipals = readAllowedPrincipals(value, index);

    if (seen.has(id)) {
      throw new ConfigError(`Workspace duplicado na configuracao: "${id}".`);
    }
    seen.add(id);

    // Caminho absoluto e mantido; relativo e resolvido contra o diretorio do JSON.
    const rootPath = path.isAbsolute(rootPathRaw)
      ? path.normalize(rootPathRaw)
      : path.resolve(baseDir, rootPathRaw);
    definitions.push({ id, name, rootPath, allowedPrincipals });
  });

  return definitions;
}

/**
 * Le a configuracao de workspaces. Nao acessa o catalogo SQLite nem o MCP.
 * Sincrona: roda uma unica vez no startup da aplicacao.
 */
export function loadWorkspaceDefinitions(
  options: LoadWorkspaceDefinitionsOptions = {},
): LoadedWorkspaceDefinitions {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const configured = env[WORKSPACES_FILE_ENV]?.trim();
  const explicit = configured !== undefined && configured.length > 0;
  const filePath = path.resolve(cwd, explicit ? configured : DEFAULT_WORKSPACES_FILE);

  let stats;
  try {
    stats = statSync(filePath);
  } catch (error) {
    if (!explicit && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { definitions: [], source: "empty" };
    }
    throw new ConfigError(
      explicit
        ? `Arquivo de workspaces configurado em ${WORKSPACES_FILE_ENV} nao existe ou nao e acessivel.`
        : "Nao foi possivel ler o arquivo padrao de workspaces.",
    );
  }

  if (!stats.isFile()) {
    throw new ConfigError("O caminho da configuracao de workspaces nao e um arquivo.");
  }
  if (stats.size > MAX_CONFIG_BYTES) {
    throw new ConfigError(
      `Arquivo de workspaces excede o limite de ${MAX_CONFIG_BYTES} bytes.`,
    );
  }

  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    throw new ConfigError("Falha ao ler o arquivo de workspaces configurado.");
  }

  return {
    definitions: parseDefinitions(text, filePath),
    source: "file",
    filePath,
  };
}
