/**
 * Wire constants for Affinity's local MCP server.
 *
 * Affinity ships an MCP server on the IPv6 loopback and speaks the legacy HTTP+SSE
 * transport. Three properties are load-bearing and verified against
 * Affinity 3.3.3.5004 (macOS):
 *
 *  1. It accepts protocol `2025-11-25` only; anything else is refused with -32602.
 *  2. It listens on `[::1]` only; `127.0.0.1` connections are refused.
 *  3. The SDK documentation gate is per MCP session: `read_sdk_documentation_topic`
 *     refuses every topic until `preamble` has been read in that same session, and
 *     `execute_script` refuses to run at all until then. The two refusals differ:
 *     `execute_script` sets `isError`, a topic read answers the refusal as plain text.
 *
 * Property 3 is why this package exists as a long-lived bridge rather than a
 * plain URL entry: a one-shot session can never satisfy the gate.
 */

export const PROTOCOL_VERSION = "2025-11-25";

/** Protocol versions we can echo back to a downstream client. */
export const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
]);

export const DEFAULT_URL = process.env.AFFINITY_MCP_URL ?? "http://[::1]:6767/sse";

/** Upstream request timeout in milliseconds (`AFFINITY_MCP_TIMEOUT` is in seconds). */
export const DEFAULT_TIMEOUT_MS = Math.round(
  Number(process.env.AFFINITY_MCP_TIMEOUT ?? "60") * 1000,
);

/**
 * Affinity's whole answer while the preamble gate is closed: `execute_script` sends the
 * sentence with `isError: true`, a topic read sends it prefixed `ERROR: ` with `isError: false`.
 */
export const GATE_REFUSAL = /^(ERROR: )?The preamble documentation topic has not yet been read\.$/;

/** Tools that require the preamble to have been read in this session. */
export const GATED_TOOLS = new Set(["execute_script", "read_sdk_documentation_topic"]);

/** The preamble is a documentation topic; reading it is what opens the gate. */
export const PREAMBLE_TOOL = "read_sdk_documentation_topic";
export const PREAMBLE_TOPIC = "preamble";

/**
 * Tools that only read, so a call that timed out can be sent again on a fresh session.
 * The others (execute_script, save_script_to_library, add_sdk_hint, report_sdk_issue)
 * may already have acted in the app, and sending them again would act twice.
 */
export const READ_ONLY_TOOLS = new Set([
  "list_sdk_documentation",
  "read_sdk_documentation_topic",
  "list_library_scripts",
  "read_library_script",
  "render_spread",
  "render_selection",
  "search_sdk_hints",
]);
