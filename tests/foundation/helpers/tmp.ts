import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * Temporarios SEMPRE dentro do projeto (`.tmp-tests/`), nunca em os.tmpdir().
 * O diretorio esta no .gitignore e e removido ao final de cada suite.
 */
export const TEST_TMP_ROOT = path.resolve(process.cwd(), ".tmp-tests");

export function createTestDir(label: string): string {
  mkdirSync(TEST_TMP_ROOT, { recursive: true });
  return mkdtempSync(path.join(TEST_TMP_ROOT, `${label}-`));
}

export function removeTestDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function cleanupTestRoot(): void {
  rmSync(TEST_TMP_ROOT, { recursive: true, force: true });
}
