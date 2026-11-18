import { DomainError, type PrincipalId, type WorkspaceId } from "../contracts/index.js";

/**
 * Fronteira de validacao/autorizacao de workspace.
 *
 * O modulo de colaboracao NAO conhece caminhos do host nem listas de
 * configuracao. Ele apenas pergunta ao catalogo (implementado pela frente de
 * workspace) se um `WorkspaceId` operacional existe e se o principal autenticado
 * no TRANSPORTE esta autorizado a usa-lo.
 *
 * `principalCanAccess` e OBRIGATORIO: `collab_create_room`, `collab_join_room`
 * e `collab_create_invite` recusam (fail-closed) quando o metodo esta ausente
 * ou retorna false. Isso elimina o atalho em que qualquer principal ativo
 * podia criar sala/entrar em qualquer workspace allowlisted.
 *
 * A fonte da decisao e SEMPRE o catalogo/config do servidor; nenhuma tool
 * fornece `allowedPrincipals` ou lista de principals.
 *
 * `workspaceExists` pode ser sincrono ou assincrono. `principalCanAccess` e
 * sincrono (o catalogo e em memoria); nao ha necessidade de I/O assincrono
 * para uma decisao de autorizacao fail-closed.
 */
export interface WorkspaceDirectory {
  workspaceExists(workspaceId: WorkspaceId): boolean | Promise<boolean>;
  /**
   * True somente quando `principalId` consta na lista EXATA do workspace.
   * false (ou metodo ausente) => negado. Nao deve enumerar principals.
   */
  principalCanAccess(workspaceId: WorkspaceId, principalId: PrincipalId): boolean;
}

/**
 * Implementacao ESTATICA exclusiva para testes do modulo de colaboracao.
 * Nao conhece principals: por isso `principalCanAccess` retorna true para
 * qualquer ID (o catalogo real, usado em producao e nos testes de integracao,
 * aplica a lista `allowedPrincipals`). NUNCA use em producao.
 */
export function createStaticWorkspaceDirectory(
  workspaceIds: readonly (string | WorkspaceId)[],
): WorkspaceDirectory {
  const known = new Set<string>(workspaceIds.map(String));
  return {
    workspaceExists(workspaceId: WorkspaceId): boolean {
      return known.has(String(workspaceId));
    },
    principalCanAccess(): boolean {
      return true;
    },
  };
}

/** Catalogo fechado usado quando nenhuma composicao foi ligada. */
export const emptyWorkspaceDirectory: WorkspaceDirectory = createStaticWorkspaceDirectory([]);

/**
 * Erro GENERICO de autorizacao de workspace usado por create/join/create_invite.
 * Nao revela se o workspace existe, quais principals existem nem a lista
 * completa. Mesma semantica (e mensagem) do erro da politica do modulo
 * workspace, sem criar dependencia de colaboracao -> workspace.
 */
export function workspaceDirectoryDenied(): DomainError {
  return new DomainError(
    "FORBIDDEN",
    "Principal nao autorizado para este workspace.",
    {
      hint:
        "Confirme o workspaceId com o operador ou use collab_list_workspaces. Se o id estiver correto, " +
        "solicite ao operador para incluir o id da sua credencial em allowedPrincipals do workspace " +
        "(workspaces.json) e revalidar a configuracao. Convites nao ampliam esse acesso.",
    },
  );
}
