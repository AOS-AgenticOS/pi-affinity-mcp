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
export declare const PROTOCOL_VERSION = "2025-11-25";
/** Protocol versions we can echo back to a downstream client. */
export declare const SUPPORTED_PROTOCOL_VERSIONS: Set<string>;
export declare const DEFAULT_URL: string;
/** Upstream request timeout in milliseconds (`AFFINITY_MCP_TIMEOUT` is in seconds). */
export declare const DEFAULT_TIMEOUT_MS: number;
/**
 * Affinity's whole answer while the preamble gate is closed: `execute_script` sends the
 * sentence with `isError: true`, a topic read sends it prefixed `ERROR: ` with `isError: false`.
 */
export declare const GATE_REFUSAL: RegExp;
/** Tools that require the preamble to have been read in this session. */
export declare const GATED_TOOLS: Set<string>;
/** The preamble is a documentation topic; reading it is what opens the gate. */
export declare const PREAMBLE_TOOL = "read_sdk_documentation_topic";
export declare const PREAMBLE_TOPIC = "preamble";
/**
 * Tools that only read, so a call that timed out can be sent again on a fresh session.
 * The others (execute_script, save_script_to_library, add_sdk_hint, report_sdk_issue)
 * may already have acted in the app, and sending them again would act twice.
 */
export declare const READ_ONLY_TOOLS: Set<string>;
