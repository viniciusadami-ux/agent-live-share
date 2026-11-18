import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ConfigError,
  loadWorkspaceDefinitions,
} from "../../src/config/index.js";
import { cleanupTestRoot, createTestDir } from "../foundation/helpers/tmp.js";

function makeDir(label: string): string {
  return createTestDir(label);
}

afterAll(cleanupTestRoot);

describe("configuracao de workspaces (COLLAB_WORKSPACES_FILE)", () => {
  it("sem arquivo padrao: catalogo vazio e startup seguro", () => {
    const dir = makeDir("ws-config-empty");
    const loaded = loadWorkspaceDefinitions({ env: {}, cwd: dir });
    expect(loaded.definitions).toEqual([]);
    expect(loaded.source).toBe("empty");
  });

  it("arquivo explicito ausente falha alto (nao sobe com catalogo silenciosamente vazio)", () => {
    const dir = makeDir("ws-config-missing");
    expect(() =>
      loadWorkspaceDefinitions({
        env: { COLLAB_WORKSPACES_FILE: "./nao-existe.json" },
        cwd: dir,
      }),
    ).toThrow(ConfigError);
  });

  it("le { workspaces: [...] } e resolve rootPath relativo ao diretorio do JSON", () => {
    const dir = makeDir("ws-config-ok");
    mkdirSync(path.join(dir, "workspace"), { recursive: true });
    const filePath = path.join(dir, "workspaces.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        workspaces: [
          { id: "fixture", name: "Fixture", rootPath: "./workspace" },
          { id: "abs", name: "Absoluto", rootPath: path.join(dir, "workspace") },
        ],
      }),
      "utf8",
    );

    const loaded = loadWorkspaceDefinitions({
      env: { COLLAB_WORKSPACES_FILE: "workspaces.json" },
      cwd: dir,
    });
    expect(loaded.source).toBe("file");
    expect(loaded.definitions).toHaveLength(2);
    expect(loaded.definitions[0]?.id).toBe("fixture");
    expect(loaded.definitions[0]?.rootPath).toBe(path.join(dir, "workspace"));
    expect(loaded.definitions[1]?.rootPath).toBe(path.join(dir, "workspace"));
  });

  it("allowedPrincipals: lista exata e validada; ausente/vazio = fail closed", () => {
    const dir = makeDir("ws-config-principals");
    mkdirSync(path.join(dir, "workspace"), { recursive: true });
    const filePath = path.join(dir, "workspaces.json");

    // Lista valida e preservada.
    writeFileSync(
      filePath,
      JSON.stringify({
        workspaces: [
          {
            id: "ok",
            name: "OK",
            rootPath: "./workspace",
            allowedPrincipals: ["prin_test-valid-001"],
          },
        ],
      }),
      "utf8",
    );
    expect(
      loadWorkspaceDefinitions({ env: { COLLAB_WORKSPACES_FILE: "workspaces.json" }, cwd: dir })
        .definitions[0]?.allowedPrincipals,
    ).toEqual(["prin_test-valid-001"]);

    // Ausente e [] sao aceitos pelo loader (a politica fica fail-closed).
    writeFileSync(
      filePath,
      JSON.stringify({
        workspaces: [
          { id: "sem", name: "Sem", rootPath: "./workspace" },
          { id: "vazio", name: "Vazio", rootPath: "./workspace", allowedPrincipals: [] },
        ],
      }),
      "utf8",
    );
    const parsed = loadWorkspaceDefinitions({
      env: { COLLAB_WORKSPACES_FILE: "workspaces.json" },
      cwd: dir,
    }).definitions;
    expect(parsed[0]?.allowedPrincipals ?? []).toEqual([]);
    expect(parsed[1]?.allowedPrincipals).toEqual([]);

    // Formato invalido, curinga, token Bearer e duplicata falham alto.
    const invalids: unknown[] = [
      "prin_abc",
      ["nome-de-pessoa"],
      ["*"],
      ["collab_p_umToken"],
      ["prin_ok", "prin_ok"],
      [123],
    ];
    for (const allowedPrincipals of invalids) {
      writeFileSync(
        filePath,
        JSON.stringify({
          workspaces: [{ id: "x", name: "X", rootPath: "./workspace", allowedPrincipals }],
        }),
        "utf8",
      );
      expect(() =>
        loadWorkspaceDefinitions({
          env: { COLLAB_WORKSPACES_FILE: "workspaces.json" },
          cwd: dir,
        }),
      ).toThrow(ConfigError);
    }
  });

  it("workspaces.example.json e carregavel (placeholder fail-closed valido)", () => {
    const loaded = loadWorkspaceDefinitions({
      env: { COLLAB_WORKSPACES_FILE: "workspaces.example.json" },
      cwd: process.cwd(),
    });
    expect(loaded.source).toBe("file");
    expect(loaded.definitions).toHaveLength(1);
    expect(loaded.definitions[0]?.id).toBe("demo");
    expect(loaded.definitions[0]?.allowedPrincipals).toEqual([
      "prin_00000000-0000-0000-0000-000000000000",
    ]);
  });

  it("aceita array simples e rejeita JSON/shape/entradas invalidas sem expor root", () => {
    const dir = makeDir("ws-config-invalid");
    const filePath = path.join(dir, "workspaces.json");
    writeFileSync(filePath, JSON.stringify([{ id: "a", name: "A", rootPath: "./a" }]), "utf8");
    expect(
      loadWorkspaceDefinitions({
        env: { COLLAB_WORKSPACES_FILE: "workspaces.json" },
        cwd: dir,
      }).definitions,
    ).toHaveLength(1);

    writeFileSync(filePath, "{ nao e json", "utf8");
    expect(() =>
      loadWorkspaceDefinitions({
        env: { COLLAB_WORKSPACES_FILE: "workspaces.json" },
        cwd: dir,
      }),
    ).toThrow(/JSON/i);

    writeFileSync(filePath, JSON.stringify({ outros: [] }), "utf8");
    expect(() =>
      loadWorkspaceDefinitions({
        env: { COLLAB_WORKSPACES_FILE: "workspaces.json" },
        cwd: dir,
      }),
    ).toThrow(/workspaces/i);

    writeFileSync(
      filePath,
      JSON.stringify({ workspaces: [{ id: "a", name: "A" }] }),
      "utf8",
    );
    try {
      loadWorkspaceDefinitions({
        env: { COLLAB_WORKSPACES_FILE: "workspaces.json" },
        cwd: dir,
      });
      throw new Error("Esperava ConfigError para entrada sem rootPath");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect(String((error as Error).message)).toContain("rootPath");
    }

    writeFileSync(
      filePath,
      JSON.stringify({
        workspaces: [
          { id: "dup", name: "A", rootPath: "./a" },
          { id: "dup", name: "B", rootPath: "./b" },
        ],
      }),
      "utf8",
    );
    expect(() =>
      loadWorkspaceDefinitions({
        env: { COLLAB_WORKSPACES_FILE: "workspaces.json" },
        cwd: dir,
      }),
    ).toThrow(/duplicado/i);
  });
});
