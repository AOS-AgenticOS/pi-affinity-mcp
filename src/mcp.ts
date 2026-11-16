/**
 * MCP server semantics, independent of the transport.
 *
 * The same core serves the stdio transport (pi, mcporter, Claude Desktop, Codex)
 * and the HTTP transport (`--http`, used when the client cannot run on the same
 * machine as Affinity, e.g. a container).
 */

import { createInterface } from "node:readline";

import type { AffinityBridge } from "./bridge.js";
import { AffinityRpcError } from "./client.js";
import { PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "./protocol.js";
import type { JsonRpcRequest, JsonRpcResponse } from "./types.js";
import { SERVER_NAME, VERSION } from "./version.js";

const INSTRUCTIONS = [
  "Affinity by Canva local MCP.",
  "Read the 'preamble' SDK documentation topic before executing scripts; this bridge primes it automatically.",
  "Use list_sdk_documentation to discover topics, read_sdk_documentation_topic to read them,",
  "execute_script to run JavaScript against the Affinity SDK, and render_spread / render_selection",
  "to verify results visually.",
].join(" ");

export type McpServerOptions = {
  /** Whether this transport can send `notifications/tools/list_changed` (stdio can, stateless HTTP cannot). */
  listChanged?: boolean;
  /**
   * The only tools this server offers (`--tools`); unset: every tool Affinity has. Enforced here, not left to the
   * client: an agent with a shell can call this server directly, whatever its own client hides.
   */
  tools?: ReadonlySet<string>;
};

export class McpServerCore {
  constructor(
    private readonly bridge: AffinityBridge,
    private readonly options: McpServerOptions = {},
  ) {}

  async handle(message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = message.id;
    // Notifications (no id) never get a response, whatever their method.
    if (id === undefined || id === null) return null;

    const ok = (result: Record<string, unknown>): JsonRpcResponse => ({
      jsonrpc: "2.0",
      id,
      result,
    });
    const fail = (code: number, message: string, data?: unknown): JsonRpcResponse => ({
      jsonrpc: "2.0",
      id,
      error: data === undefined ? { code, message } : { code, message, data },
    });

    switch (message.method) {
      case "initialize": {
        const requested = message.params?.protocolVersion;
        const protocolVersion =
          typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
            ? requested
            : PROTOCOL_VERSION;
        return ok({
          protocolVersion,
          capabilities: { tools: { listChanged: this.options.listChanged ?? false } },
          serverInfo: { name: SERVER_NAME, version: VERSION },
          instructions: INSTRUCTIONS,
        });
      }
      case "ping":
        return ok({});
      case "tools/list": {
        try {
          const tools = await this.bridge.listTools();
          const offered = this.options.tools;
          return ok({ tools: offered ? tools.filter((tool) => offered.has(String(tool.name))) : tools });
        } catch (error) {
          return fail(-32603, `Affinity unavailable: ${(error as Error).message}`);
        }
      }
      case "tools/call": {
        const name = message.params?.name;
        if (typeof name !== "string" || !name) return fail(-32602, "tools/call needs a tool name");
        if (this.options.tools && !this.options.tools.has(name)) {
          return fail(-32602, `Tool not offered by this server: ${name}`);
        }
        const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          return ok(await this.bridge.callTool(name, args));
        } catch (error) {
          // Affinity's own protocol errors (unknown tool, bad arguments) pass through as they are.
          if (error instanceof AffinityRpcError) return fail(error.code, error.message, error.data);
          // Anything else is a failed call: a tool result, so the model reads it and can act on it.
          return ok({
            isError: true,
            content: [{ type: "text", text: `Affinity call failed: ${(error as Error).message}` }],
          });
        }
      }
      default:
        return fail(-32601, `Method not found: ${String(message.method)}`);
    }
  }

  /** Handles one or many messages; used by both transports. */
  async handleMany(messages: JsonRpcRequest[]): Promise<JsonRpcResponse[]> {
    const responses = await Promise.all(messages.map((message) => this.handle(message)));
    return responses.filter((response): response is JsonRpcResponse => response !== null);
  }
}

/** Newline-delimited JSON-RPC 2.0 on stdin/stdout, nothing else on stdout. */
export async function runStdioServer(core: McpServerCore, bridge: AffinityBridge): Promise<void> {
  const write = (payload: unknown): void => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };
  // Affinity never announces tool changes; the bridge notices them when a new session opens.
  bridge.on("toolsChanged", () => {
    write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  });
  const stdin = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const raw of stdin) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: JsonRpcRequest | JsonRpcRequest[];
    try {
      parsed = JSON.parse(line) as JsonRpcRequest | JsonRpcRequest[];
    } catch {
      console.error("[pi-affinity-mcp] ignoring non-JSON input:", line.slice(0, 120));
      continue;
    }
    // Batches are tolerated even though MCP 2025-11-25 no longer uses them.
    const batch = Array.isArray(parsed) ? parsed : [parsed];
    for (const response of await core.handleMany(batch)) write(response);
  }
}
