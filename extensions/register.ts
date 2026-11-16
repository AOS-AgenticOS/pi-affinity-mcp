/**
 * Pi extension: registers the Affinity MCP server for the session.
 *
 * This is the whole reason the package exists as a Pi package — install it and
 * Affinity's tools are there, with no mcp.json editing. The bridge itself is a
 * plain MCP server, so any other client can use it without this file.
 */

import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

export default function affinityMcp(pi: ExtensionAPI): void {
  // Older pi builds have no MCP registration; they can still use the server
  // through mcp.json, so this degrades to "nothing to do" instead of failing.
  const api = pi as ExtensionAPI & {
    registerMcpServer?: (name: string, config: Record<string, unknown>) => void;
  };
  if (typeof api.registerMcpServer !== "function") return;

  api.registerMcpServer("affinity", {
    command: process.execPath,
    args: [CLI],
    // The point of this server is scripting and rendering: expose it directly
    // rather than hiding the tools behind codemode's search step.
    exposure: "direct",
    // An execute_script may build a whole spread; the bridge's own timeout
    // (AFFINITY_MCP_TIMEOUT, 60 s) is the real limit.
    timeout: 180,
    description:
      "Affinity by Canva: read the JavaScript SDK docs, run scripts against the live app, render spreads and selections.",
  });
}
