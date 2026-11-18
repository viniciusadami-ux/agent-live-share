import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { asContentHash, DomainError, type ContentHash } from "../contracts/index.js";

/** SHA-256 hexadecimal sobre os BYTES exatos (nao sobre string normalizada). */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function hashOf(bytes: Uint8Array): ContentHash {
  return asContentHash(sha256Hex(bytes));
}

/** Decodifica UTF-8 estrito. Rejeita binario (NUL / UTF-8 invalido). */
export function decodeUtf8(bytes: Uint8Array, maxBytes: number): string {
  if (bytes.length > maxBytes) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `Arquivo excede o limite de ${maxBytes} bytes.`,
      {
        hint: "Reduza o arquivo ou aumente maxFileBytes na configuracao do servidor. Leituras e escritas sao limitadas.",
      },
    );
  }
  for (const byte of bytes) {
    if (byte === 0) {
      throw new DomainError("VALIDATION_FAILED", "Arquivo binario (byte NUL) nao permitido.", {
        hint: "O MVP aceita apenas arquivos de texto UTF-8. Converta ou ignore o arquivo binario.",
      });
    }
  }
  try {
    // ignoreBOM:true preserva U+FEFF para que Buffer.from(text) reproduza os
    // bytes originais (BOM incluido) em restauracoes/patches.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new DomainError("VALIDATION_FAILED", "Arquivo nao e UTF-8 valido (binario).", {
      hint: "O MVP aceita apenas arquivos de texto UTF-8.",
    });
  }
}

export function encodeUtf8(text: string): Uint8Array {
  return Buffer.from(text, "utf8");
}

/** Converte valor BLOB do SQLite em bytes, ou null para ausencia. */
export function bytesFromDb(value: unknown): Uint8Array | null {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return encodeUtf8(value);
  throw new DomainError("INTERNAL", "Conteudo de versao inconsistente no banco.", {
    hint: "Verifique a integridade do SQLite e as migrations aplicadas.",
  });
}

/** Le os bytes crus de um arquivo existente (sem limite; uso interno). */
export function readDiskBytes(absolute: string): Uint8Array {
  const buffer = readFileSync(absolute);
  return new Uint8Array(buffer);
}

export interface DiskState {
  readonly exists: boolean;
  readonly bytes: Uint8Array | null;
  readonly hash: string;
  readonly sizeBytes: number;
}

/** Estado atual do disco para um caminho absoluto (usado em recuperacao/hash). */
export function readDiskState(absolute: string, fsExists: boolean): DiskState {
  if (!fsExists) {
    return { exists: false, bytes: null, hash: "", sizeBytes: 0 };
  }
  const size = statSync(absolute).size;
  const bytes = readDiskBytes(absolute);
  return { exists: true, bytes, hash: sha256Hex(bytes), sizeBytes: size };
}
