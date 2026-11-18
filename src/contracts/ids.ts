/**
 * Identificadores tipados (branded strings).
 *
 * Sao `string` em runtime: nao ha validacao de formato nem regra de negocio aqui.
 * O objetivo e apenas impedir trocas acidentais entre IDs de conceitos diferentes
 * (ex.: passar um RoomId onde se espera um AgentId). A geracao/validacao real
 * pertence aos modulos de colaboracao/workspace, nao a fundacao.
 */
declare const ID_BRAND: unique symbol;

export type BrandedId<TKind extends string> = string & {
  readonly [ID_BRAND]: TKind;
};

export type AgentId = BrandedId<"AgentId">;
export type SessionId = BrandedId<"SessionId">;
export type RoomId = BrandedId<"RoomId">;
export type WorkspaceId = BrandedId<"WorkspaceId">;
export type TaskId = BrandedId<"TaskId">;
export type MessageId = BrandedId<"MessageId">;
export type LockId = BrandedId<"LockId">;
export type FileVersionId = BrandedId<"FileVersionId">;
export type CheckpointId = BrandedId<"CheckpointId">;
/** Identidade de TRANSPORTE (pessoa/cliente/instalacao), nao um agente de sala. */
export type PrincipalId = BrandedId<"PrincipalId">;

/** Cursor opaco usado por "consultar atualizacoes desde um cursor". */
export type Cursor = BrandedId<"Cursor">;
/** Hash do conteudo de um arquivo, no formato definido pelo modulo de workspace. */
export type ContentHash = BrandedId<"ContentHash">;
/** Data/hora ISO 8601 em UTC. */
export type IsoDateTime = BrandedId<"IsoDateTime">;
/** Caminho normalizado, relativo a raiz do workspace (sem `..`, sem escapar). */
export type NormalizedPath = BrandedId<"NormalizedPath">;

/** Marca uma string como um ID daquele tipo. Nao valida conteudo. */
export function brandId<TKind extends string>(value: string): BrandedId<TKind> {
  return value as BrandedId<TKind>;
}

export const asAgentId = (value: string): AgentId => brandId<"AgentId">(value);
export const asSessionId = (value: string): SessionId => brandId<"SessionId">(value);
export const asRoomId = (value: string): RoomId => brandId<"RoomId">(value);
export const asWorkspaceId = (value: string): WorkspaceId => brandId<"WorkspaceId">(value);
export const asTaskId = (value: string): TaskId => brandId<"TaskId">(value);
export const asMessageId = (value: string): MessageId => brandId<"MessageId">(value);
export const asLockId = (value: string): LockId => brandId<"LockId">(value);
export const asFileVersionId = (value: string): FileVersionId => brandId<"FileVersionId">(value);
export const asCheckpointId = (value: string): CheckpointId => brandId<"CheckpointId">(value);
export const asPrincipalId = (value: string): PrincipalId => brandId<"PrincipalId">(value);
export const asCursor = (value: string): Cursor => brandId<"Cursor">(value);
export const asContentHash = (value: string): ContentHash => brandId<"ContentHash">(value);
export const asIsoDateTime = (value: string): IsoDateTime => brandId<"IsoDateTime">(value);
export const asNormalizedPath = (value: string): NormalizedPath => brandId<"NormalizedPath">(value);
