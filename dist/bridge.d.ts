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
 *  - serialise calls, because the upstream session is a single request/response channel.
 */
import { EventEmitter } from "node:events";
export type BridgeOptions = {
    url: string;
    timeoutMs?: number;
    debug?: boolean;
};
export declare class AffinityBridge extends EventEmitter {
    private readonly url;
    private readonly timeoutMs;
    private readonly debug;
    private client?;
    private primed;
    private tail;
    private tools?;
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
    private serialize;
    callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
    listTools(): Promise<Array<Record<string, unknown>>>;
    close(): void;
}
