/**
 * The bridge: one long-lived Affinity session, shared by every downstream call.
 *
 * Responsibilities, in the order they matter:
 *  - keep exactly one upstream SSE session (Affinity allows a single stream per session),
 *  - prime the SDK documentation gate before gated tools, transparently,
 *  - re-prime and retry once when the gate trips anyway,
 *  - open a new session when the stream ends (Affinity quit or restarted),
 *  - re-read the tool list on every new session and emit `toolsChanged` when it differs,
 *  - on timeout, drop the session; re-send the call once only if it is read-only,
 *  - serialise calls, because the upstream session is a single request/response channel,
 *  - with `ownDocuments`, know which documents its scripts opened, to close exactly those when it stops.
 */
import { EventEmitter } from "node:events";
export type BridgeOptions = {
    url: string;
    timeoutMs?: number;
    debug?: boolean;
    /**
     * Track the documents this bridge's scripts open (`--close-documents`), so `closeDocuments()` closes those and
     * no document a person opened in the app. One bridge then serves one agent's work.
     */
    ownDocuments?: boolean;
};
export declare class AffinityBridge extends EventEmitter {
    private readonly url;
    private readonly timeoutMs;
    private readonly debug;
    private client?;
    private primed;
    private tail;
    private tools?;
    private readonly ownDocuments;
    /** Documents a script of this bridge opened and has not closed. */
    private readonly owned;
    /** Documents that were open before, or appeared between this bridge's scripts: somebody else's. */
    private readonly others;
    /** A script of this bridge never answered: what it opened is still unrecorded. */
    private unsettled;
    constructor(options: BridgeOptions);
    private log;
    private ensure;
    /** A new session may be a new Affinity version; tell listeners when its tools differ. */
    private refreshTools;
    private drop;
    /**
     * Read the preamble in the current session; required before any SDK work.
     *
     * Observed on Affinity 3.3.3: a session can answer `File not found` for topics
     * while a freshly opened stream serves them, so a failed prime reconnects once
     * before the failure is reported.
     */
    private prime;
    private invoke;
    /**
     * Read which documents are open. One not seen before is this bridge's when `mine` (seen right after its own
     * script, or after a script of its own that never answered), somebody else's otherwise.
     */
    private observe;
    /** A script, with the documents it opens recorded as this bridge's. */
    private runOwnScript;
    private serialize;
    callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
    listTools(): Promise<Array<Record<string, unknown>>>;
    /** Close the documents this bridge's scripts opened and left open; returns their session UUIDs. */
    closeDocuments(): Promise<string[]>;
    close(): void;
}
