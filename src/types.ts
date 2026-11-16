/** Wire types shared by the client, the stdio server and the HTTP server. */

import { PROTOCOL_VERSION } from "./protocol.js";
import { VERSION } from "./version.js";

export type JsonRpcId = number | string | null;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

export type JsonRpcResult = Record<string, unknown>;

export type ToolsListResult = {
  tools: Array<Record<string, unknown>>;
};

/**
 * Identity this bridge presents upstream. Affinity does not care about the name;
 * it does care that the protocol version is exactly the one it supports.
 */
export const CLIENT_INFO_FALLBACK = {
  name: "pi-affinity-mcp",
  version: VERSION,
  protocolVersion: PROTOCOL_VERSION,
} as const;
