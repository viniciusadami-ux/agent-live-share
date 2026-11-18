import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** Cliente MCP OFICIAL do SDK, conectado por HTTP real (nao mock de transporte). */
export interface TestMcpClient {
  readonly client: Client;
  close(): Promise<void>;
}

/**
 * `bearerToken` opcional: ausente permite testar 401; presente envia
 * `Authorization: Bearer` em TODAS as requisicoes do transporte (initialize,
 * POST, GET/SSE e DELETE), via `requestInit.headers`.
 */
export async function connectTestMcpClient(
  mcpUrl: string,
  bearerToken?: string,
): Promise<TestMcpClient> {
  const options =
    bearerToken === undefined
      ? undefined
      : { requestInit: { headers: { Authorization: `Bearer ${bearerToken}` } } };
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), options);
  const client = new Client({
    name: "collab-mcp-foundation-tests",
    version: "0.1.0",
  });
  await client.connect(transport);
  return {
    client,
    close: () => client.close(),
  };
}
