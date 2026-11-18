import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Arquivos de teste abrem servidores HTTP e bancos SQLite em disco.
    // Um unico processo sequencial evita disputa de porta/arquivo no Windows.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
