import { describe, expect, it } from "vitest";
import {
  DomainError,
  isDomainError,
  toErrorPayload,
} from "../../src/contracts/errors.js";
import { asAgentId, asRoomId, brandId } from "../../src/contracts/ids.js";
import { err, ok } from "../../src/contracts/primitives.js";
import { isRole, ROLES } from "../../src/contracts/roles.js";

describe("contratos compartilhados", () => {
  it("IDs branded sao strings em runtime (sem regra de negocio)", () => {
    expect(asAgentId("agent-1")).toBe("agent-1");
    expect(asRoomId("room-1")).toBe("room-1");
    expect(brandId<"ProbeId">("x")).toBe("x");
  });

  it("DomainError carrega code/hint para erros acionaveis", () => {
    const error = new DomainError("LOCK_NOT_HELD", "Arquivo sem lock valido.", {
      hint: "Solicite o lock e releia o arquivo antes de gravar.",
      context: { path: "src/app.js" },
    });
    expect(isDomainError(error)).toBe(true);
    expect(error.name).toBe("DomainError");
    expect(toErrorPayload(error)).toEqual({
      code: "LOCK_NOT_HELD",
      message: "Arquivo sem lock valido.",
      hint: "Solicite o lock e releia o arquivo antes de gravar.",
    });
  });

  it("toErrorPayload nao vaza detalhes de erros inesperados", () => {
    const payload = toErrorPayload(
      new Error("ENOENT: no such file, open 'E:\\segredo\\root\\arquivo.txt'"),
    );
    expect(payload.code).toBe("INTERNAL");
    expect(payload.hint).toMatch(/logs/);
    expect(payload.message).not.toContain("segredo");
    expect(JSON.stringify(payload)).not.toContain("E:");
  });

  it("helpers de Result", () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
    const failure = err(new DomainError("NOT_FOUND", "ausente"));
    expect(failure.ok).toBe(false);
  });

  it("papeis previstos: coordinator, worker, reviewer", () => {
    expect(ROLES).toEqual(["coordinator", "worker", "reviewer"]);
    expect(isRole("coordinator")).toBe(true);
    expect(isRole("worker")).toBe(true);
    expect(isRole("reviewer")).toBe(true);
    expect(isRole("admin")).toBe(false);
  });
});
