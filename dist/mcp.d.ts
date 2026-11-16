/**
 * MCP server semantics, independent of the transport.
 *
 * The same core serves the stdio transport (pi, mcporter, Claude Desktop, Codex)
 * and the HTTP transport (`--http`, used when the client cannot run on the same
 * machine as Affinity, e.g. a container).
 */
import type { AffinityBridge } from "./bridge.js";
import type { JsonRpcRequest, JsonRpcResponse } from "./types.js";
export type McpServerOptions = {
    /** Whether this transport can send `notifications/tools/list_changed` (stdio can, stateless HTTP cannot). */
    listChanged?: boolean;
    /**
     * The only tools this server offers (`--tools`); unset: every tool Affinity has. Enforced here, not left to the
     * client: an agent with a shell can call this server directly, whatever its own client hides.
     */
    tools?: ReadonlySet<string>;
};
export declare class McpServerCore {
    private readonly bridge;
    private readonly options;
    constructor(bridge: AffinityBridge, options?: McpServerOptions);
    handle(message: JsonRpcRequest): Promise<JsonRpcResponse | null>;
    /** Handles one or many messages; used by both transports. */
    handleMany(messages: JsonRpcRequest[]): Promise<JsonRpcResponse[]>;
}
/** Newline-delimited JSON-RPC 2.0 on stdin/stdout, nothing else on stdout. */
export declare function runStdioServer(core: McpServerCore, bridge: AffinityBridge): Promise<void>;
