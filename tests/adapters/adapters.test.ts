import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DIAGNOSTICS_TOOL_NAME } from "../../src/server/diagnostics.js";
import { COLLABORATION_TOOL_NAMES } from "../../src/collaboration/tools.js";
import {
  CHECKPOINT_TOOL_NAMES,
  WORKSPACE_TOOL_NAMES,
} from "../../src/workspace/toolModule.js";
import { LOCKING_TOOL_NAMES } from "../../src/locking/toolModule.js";

const ROOT = process.cwd();
const ADAPTERS = path.join(ROOT, "adapters");

const ALL_TOOL_NAMES = [
  DIAGNOSTICS_TOOL_NAME,
  ...COLLABORATION_TOOL_NAMES,
  ...WORKSPACE_TOOL_NAMES,
  ...CHECKPOINT_TOOL_NAMES,
  ...LOCKING_TOOL_NAMES,
] as const;

const TOOL_SET = new Set<string>(ALL_TOOL_NAMES);

function file(relative: string): string {
  return path.join(ADAPTERS, relative);
}

function text(relative: string): string {
  return readFileSync(file(relative), "utf8");
}

function json(relative: string): Record<string, any> {
  return JSON.parse(text(relative)) as Record<string, any>;
}

function adapterFiles(): readonly string[] {
  const result: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else result.push(full);
    }
  };
  walk(ADAPTERS);
  return result;
}

/**
 * Parser TOML de subconjunto suficiente para o template do Codex
 * (tabelas, strings, inteiros e booleanos). Não é um parser TOML completo.
 */
function parseSimpleToml(source: string): Map<string, string | number | boolean> {
  const values = new Map<string, string | number | boolean>();
  let table = "";
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) {
      if (!trimmed.endsWith("]")) throw new Error(`Tabela TOML invalida: ${trimmed}`);
      table = trimmed.slice(1, -1).trim();
      if (table.length === 0) throw new Error("Tabela TOML vazia.");
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq < 1) throw new Error(`Linha TOML invalida: ${trimmed}`);
    const key = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    if (key.length === 0) throw new Error("Chave TOML vazia.");
    let value: string | number | boolean;
    if (raw.startsWith('"') && raw.endsWith('"')) {
      value = JSON.parse(raw) as string;
    } else if (raw === "true" || raw === "false") {
      value = raw === "true";
    } else if (/^-?\d+$/.test(raw)) {
      value = Number(raw);
    } else {
      throw new Error(`Valor TOML nao suportado: ${raw}`);
    }
    const full = table.length === 0 ? key : `${table}.${key}`;
    if (values.has(full)) throw new Error(`Chave TOML duplicada: ${full}`);
    values.set(full, value);
  }
  return values;
}

describe("inventario real das tools", () => {
  it("tem 37 tools unicas e todas as categorias esperadas", () => {
    expect(COLLABORATION_TOOL_NAMES).toHaveLength(20);
    expect(WORKSPACE_TOOL_NAMES).toHaveLength(8);
    expect(CHECKPOINT_TOOL_NAMES).toHaveLength(3);
    expect(LOCKING_TOOL_NAMES).toHaveLength(5);
    expect(ALL_TOOL_NAMES).toHaveLength(37);
    expect(TOOL_SET.size).toBe(37);
    expect(TOOL_SET.has("collab_status")).toBe(true);
  });

  it("a referencia compartilhada menciona todas as tools e nenhuma inventada", () => {
    const reference = text("shared/TOOL_REFERENCE.md");
    for (const name of ALL_TOOL_NAMES) {
      expect(reference, `tool ausente na referencia: ${name}`).toContain(name);
    }

    // Candidatos a nome de tool em TODOS os arquivos do adapter. Prefixos de
    // segredo (collab_p_/collab_s_/collab_i_) e o nome do produto (collab-mcp)
    // não casam com este padrao.
    const candidates = new Set<string>();
    for (const full of adapterFiles()) {
      const content = readFileSync(full, "utf8");
      for (const match of content.matchAll(/\bcollab_[a-z0-9]+(?:_[a-z0-9]+)*\b/g)) {
        candidates.add(match[0]);
      }
    }
    for (const candidate of candidates) {
      expect(TOOL_SET.has(candidate), `tool inventada em adapter: ${candidate}`).toBe(true);
    }

    const protocol = text("shared/AGENT_PROTOCOL.md");
    for (const required of [
      "collab_status",
      "collab_list_workspaces",
      "collab_create_room",
      "collab_join_room",
      "collab_heartbeat",
      "collab_get_updates",
      "collab_read_file",
      "collab_lock_acquire",
      "collab_apply_patch",
      "collab_lock_release",
      "collab_submit_handoff",
      "collab_update_task",
      "collab_checkpoint_status",
      "collab_leave",
    ]) {
      expect(protocol).toContain(required);
    }
  });
});

describe("templates de clientes", () => {
  it("OpenCode V2 usa mcp.servers, oauth=false, codemode=false e env placeholder", () => {
    const config = json("opencode/opencode.json");
    const server = config["mcp"]?.["servers"]?.["collab"];

    expect(server).toMatchObject({
      type: "remote",
      url: "http://127.0.0.1:3100/mcp",
      oauth: false,
      codemode: false,
      protocol: "legacy",
    });
    expect(server?.["headers"]?.["Authorization"]).toBe(
      "Bearer {env:COLLAB_MCP_BEARER}",
    );
    // Nao aceitar a sintaxe V1 `mcp.<nome>`.
    expect(config["mcp"]?.["collab"]).toBeUndefined();
    expect(text("opencode/README.md")).toContain("https://opencode.ai/v2/docs/mcp-servers");
  });

  it("Codex config.toml e parseavel e usa bearer_token_env_var, sem token", () => {
    const source = text("codex/config.toml");
    const toml = parseSimpleToml(source);

    expect(toml.get("mcp_servers.collab.url")).toBe("http://127.0.0.1:3100/mcp");
    expect(toml.get("mcp_servers.collab.bearer_token_env_var")).toBe(
      "COLLAB_MCP_BEARER",
    );
    expect(toml.get("mcp_servers.collab.enabled")).toBe(true);
    expect(source).not.toMatch(/Authorization\s*=/);
    expect(text("codex/README.md")).toContain(
      "https://developers.openai.com/codex/extend/mcp",
    );
  });

  it("Claude Code .mcp.json usa type http, URL e ${VAR}, sem token", () => {
    const config = json("claude-code/mcp.json.example");
    const server = config["mcpServers"]?.["collab"];

    expect(server).toMatchObject({
      type: "http",
      url: "http://127.0.0.1:3100/mcp",
    });
    expect(server?.["headers"]?.["Authorization"]).toBe(
      "Bearer ${COLLAB_MCP_BEARER}",
    );
    expect(text("claude-code/README.md")).toContain("https://code.claude.com/docs/en/mcp");
    expect(text("claude-code/README.md")).toContain("claude mcp add");
  });

  it("tailscale runbook cobre Serve, allowed hosts e proxy sem afirmar configuracao", () => {
    const runbook = text("tailscale/README.md");
    expect(runbook).toContain("tailscale serve --bg 3100");
    expect(runbook).toContain("tailscale serve status");
    expect(runbook).toContain("COLLAB_ALLOWED_HOSTS");
    expect(runbook).toContain("COLLAB_TRUST_PROXY");
    expect(runbook).toContain("tailscale funnel");
    expect(runbook).toMatch(/n[aã]o.*configurado/i);
    expect(runbook).toContain("https://tailscale.com/docs/reference/tailscale-cli/serve");
  });

  it("package.json expoe check:mcp", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.["check:mcp"]).toBe(
      "tsx adapters/scripts/check-mcp-connection.ts",
    );
    expect(existsSync(file("scripts/check-mcp-connection.ts"))).toBe(true);
  });
});

describe("seguranca dos templates", () => {
  it("nao contem tokens reais, Authorization hardcoded ou principal real", () => {
    const violations: string[] = [];
    for (const full of adapterFiles()) {
      const content = readFileSync(full, "utf8");
      if (/collab_p_[A-Za-z0-9_-]{8,}/.test(content)) violations.push(`${full}: bearer`);
      if (/collab_s_[A-Za-z0-9_-]{8,}/.test(content)) violations.push(`${full}: session`);
      if (/collab_i_[A-Za-z0-9_-]{8,}/.test(content)) violations.push(`${full}: invite`);
      if (
        /prin_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(
          content,
        )
      ) {
        violations.push(`${full}: principal`);
      }
      if (
        /Authorization\s*[:=]\s*["']?Bearer\s+(?!\{env:|\$\{|<)/.test(content)
      ) {
        violations.push(`${full}: authorization hardcoded`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("templates nao contem rootPath nem allowedPrincipals", () => {
    for (const relative of [
      "opencode/opencode.json",
      "codex/config.toml",
      "claude-code/mcp.json.example",
    ]) {
      const content = text(relative);
      expect(content).not.toContain("rootPath");
      expect(content).not.toContain("allowedPrincipals");
    }
  });
});
