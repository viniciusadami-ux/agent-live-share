import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { isDomainError } from "../../src/contracts/index.js";
import type { AuthenticatedActor } from "../../src/collaboration/index.js";
import {
  createWorkspaceFixture,
  cleanupTestRoot,
  type WorkspaceFixture,
} from "./helpers/fixture.js";
import { setupRoomWithWorker } from "./helpers/rooms.js";
import {
  listFiles,
  normalizeRelativePath,
  readFile,
  searchFiles,
} from "../../src/workspace/index.js";

let current: WorkspaceFixture;
let actor: AuthenticatedActor;

beforeEach(async () => {
  current = createWorkspaceFixture();
  const room = await setupRoomWithWorker(current.collaboration, current.clock);
  actor = current.collaboration.authenticate(room.coordinatorToken);
});
afterEach(() => {
  try {
    current.close();
  } catch {
    /* ja fechado */
  }
});
afterAll(cleanupTestRoot);

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    if (isDomainError(error)) return error.code;
    return `NON_DOMAIN:${String(error)}`;
  }
}

describe("normalizacao de caminho relativo", () => {
  it("aceita separadores / e \\ e produz chave estavel case-folded", () => {
    const a = normalizeRelativePath("src/login.html");
    const b = normalizeRelativePath("src\\login.html");
    expect(String(a.display)).toBe("src/login.html");
    expect(String(b.display)).toBe("src/login.html");
    expect(a.key).toBe("src/login.html");
    expect(normalizeRelativePath("Src/Login.html").key).toBe(a.key);
    expect(String(normalizeRelativePath("./src//login.html").display)).toBe("src/login.html");
  });

  it("rejeita absoluto, drive, UNC, .., NUL, controle e ADS", () => {
    const invalid = [
      "/etc/passwd",
      "\\windows\\system32",
      "C:\\segredo\\x.txt",
      "C:/segredo/x.txt",
      "\\\\server\\share\\x",
      "//server/share/x",
      "src/../segredo",
      "../segredo",
      "..\\segredo",
      "src\u0000/x.txt",
      "src/nome:stream.txt",
      "src/nome.",
      "src /nome", // espaco final em segmento INTERMEDIARIO (Windows normaliza)
      "",
      "   ",
    ];
    for (const value of invalid) {
      expect(codeOf(() => normalizeRelativePath(value)), `valor: ${JSON.stringify(value)}`).toBeDefined();
    }
  });

  it("rejeita nomes reservados e caracteres invalidos do Windows", () => {
    if (process.platform !== "win32") return;
    for (const value of ["CON", "nul.txt", "src/AUX", "COM1.log", "src/a?b.txt", "src/a|b.txt"]) {
      expect(codeOf(() => normalizeRelativePath(value)), `valor: ${value}`).toBeDefined();
    }
  });
});

describe("list / read / search na fixture", () => {
  it("list_files pagina e ignora .git, node_modules e arquivos internos", () => {
    const result = listFiles(current.runtime, actor, { limit: 200 });
    const paths = result.entries.map((entry) => String(entry.path));
    expect(paths).toContain("login.html");
    expect(paths).toContain("src/app.ts");
    expect(paths).toContain("README.md");
    expect(paths.some((p) => p.startsWith(".git"))).toBe(false);
    expect(paths.some((p) => p.startsWith("node_modules"))).toBe(false);
    expect(result.total).toBeGreaterThan(0);
    expect(result.hasMore).toBe(false);
    const page1 = listFiles(current.runtime, actor, { offset: 0, limit: 2 });
    expect(page1.entries).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
  });

  it("read_file retorna conteudo, hash SHA-256 e versao (leitura NAO exige lock)", () => {
    const result = readFile(current.runtime, actor, { path: "login.html" });
    expect(result.content).toBe("<h1>Login</h1>\n");
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.version).toBe(0);
    expect(result.tracked).toBe(false);
    expect(result.encoding).toBe("utf-8");
    expect(String(result.path)).toBe("login.html");
  });

  it("search encontra por nome e por conteudo com snippet de linha", () => {
    const byContent = searchFiles(current.runtime, actor, {
      query: "searchable-token",
      mode: "content",
    });
    expect(byContent.matches.length).toBeGreaterThan(0);
    const match = byContent.matches.find((m) => m.kind === "content");
    expect(match?.line).toBeGreaterThan(0);
    expect(match?.snippet).toContain("searchable-token");
    const byName = searchFiles(current.runtime, actor, { query: "app.ts", mode: "name" });
    expect(byName.matches.some((m) => String(m.path) === "src/app.ts")).toBe(true);
  });
});

describe("limites: binario e arquivo grande", () => {
  it("rejeita arquivo binario (byte NUL) com erro acionavel", () => {
    current.writeHostFile("bin.dat", "abc\u0000def");
    expect(codeOf(() => readFile(current.runtime, actor, { path: "bin.dat" }))).toBe(
      "VALIDATION_FAILED",
    );
  });

  it("rejeita arquivo acima de maxFileBytes (limite configuravel)", async () => {
    const small = createWorkspaceFixture({ limits: { maxFileBytes: 100 } });
    try {
      small.writeHostFile("big.txt", "x".repeat(200));
      const room = await setupRoomWithWorker(small.collaboration, small.clock);
      const smallActor = small.collaboration.authenticate(room.coordinatorToken);
      expect(codeOf(() => readFile(small.runtime, smallActor, { path: "big.txt" }))).toBe(
        "VALIDATION_FAILED",
      );
    } finally {
      small.close();
    }
  });
});

describe("contencontrao no root real: symlink/junction", () => {
  it("nao segue junction que aponta para fora do workspace", () => {
    const outside = path.join(current.dir, "outside-secret");
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "secret.txt"), "SECRET FORA DO ROOT", "utf8");
    const link = path.join(current.root, "escape");
    let created = false;
    try {
      symlinkSync(outside, link, "junction");
      created = true;
    } catch (error) {
      // Skip SOMENTE com motivo real de permissao (Developer Mode no Windows).
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES") throw error;
    }
    if (!created) return; // sem privilegio para criar junction neste host
    expect(codeOf(() => readFile(current.runtime, actor, { path: "escape/secret.txt" }))).toBe(
      "PATH_OUTSIDE_WORKSPACE",
    );
    expect(codeOf(() => listFiles(current.runtime, actor, { path: "escape" }))).toBe(
      "PATH_OUTSIDE_WORKSPACE",
    );
  });

  it("nao segue symlink de ARQUIVO para fora do workspace (skip so por permissao)", () => {
    const outside = path.join(current.dir, "outside-file.txt");
    writeFileSync(outside, "SEGREDO FORA", "utf8");
    const link = path.join(current.root, "link-secreto.txt");
    let created = false;
    try {
      symlinkSync(outside, link, "file");
      created = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Sem Developer Mode/privilegio, NAO e possivel criar file symlink;
      // junction (testado acima) cobre o mesmo mecanismo de deteccao.
      if (code !== "EPERM" && code !== "EACCES" && code !== "UNKNOWN") throw error;
    }
    if (!created) return; // skip com motivo real de permissao
    expect(codeOf(() => readFile(current.runtime, actor, { path: "link-secreto.txt" }))).toBe(
      "PATH_OUTSIDE_WORKSPACE",
    );
  });
});
