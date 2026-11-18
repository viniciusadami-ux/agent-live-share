/**
 * Erros de dominio: apenas o formato/contrato. Nenhuma regra de quando lancar
 * cada codigo e implementada aqui (isso pertence aos modulos de negocio).
 *
 * O planejamento exige que toda ferramenta devolva erros uteis e acionaveis:
 * `code` identifica o motivo, `hint` sugere o proximo passo possivel.
 */

export type DomainErrorCode =
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "VALIDATION_FAILED"
  | "INVALID_STATE"
  | "FORBIDDEN"
  | "CONFLICT"
  | "SESSION_INACTIVE"
  // Reservados para as frentes de workspace/locking.
  | "LOCK_NOT_HELD"
  | "LOCK_ALREADY_HELD"
  | "LOCK_EXPIRED"
  | "VERSION_MISMATCH"
  | "HASH_MISMATCH"
  | "PATCH_NOT_APPLICABLE"
  | "PATH_OUTSIDE_WORKSPACE"
  | "CHECKPOINT_IN_PROGRESS"
  | "INTERNAL";

export interface DomainErrorOptions {
  /** Proximo passo possivel para o agente que recebeu o erro. */
  readonly hint?: string;
  /** Contexto nao sensivel; nunca incluir tokens, segredos ou conteudo de arquivo. */
  readonly context?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly hint: string | undefined;
  readonly context: Readonly<Record<string, unknown>> | undefined;

  constructor(code: DomainErrorCode, message: string, options: DomainErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DomainError";
    this.code = code;
    this.hint = options.hint;
    this.context = options.context;
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}

/** Payload estavel para ferramentas MCP devolverem erros acionaveis. */
export interface DomainErrorPayload {
  readonly code: DomainErrorCode;
  readonly message: string;
  readonly hint: string;
}

export function toErrorPayload(error: unknown): DomainErrorPayload {
  if (isDomainError(error)) {
    return {
      code: error.code,
      message: error.message,
      hint: error.hint ?? "Corrija a condicao indicada e tente novamente.",
    };
  }
  // Nunca serialize a mensagem crua de um erro inesperado: ela pode conter
  // caminho absoluto do host (ENOENT/EACCES) ou outro detalhe interno. O log
  // local do servidor continua disponivel para diagnostico.
  return {
    code: "INTERNAL",
    message: "Erro interno inesperado.",
    hint: "Verifique os logs do servidor e tente novamente.",
  };
}
