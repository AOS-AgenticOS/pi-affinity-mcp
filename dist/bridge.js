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
import { AffinityClient, AffinityError, AffinityTimeoutError, flatten } from "./client.js";
import { DEFAULT_TIMEOUT_MS, DEFAULT_URL, GATE_REFUSAL, GATED_TOOLS, PREAMBLE_TOOL, PREAMBLE_TOPIC, READ_ONLY_TOOLS, } from "./protocol.js";
const isGateRefusal = (result) => GATE_REFUSAL.test(flatten(result).trim());
export class AffinityBridge extends EventEmitter {
    url;
    timeoutMs;
    debug;
    client;
    primed = false;
    tail = Promise.resolve();
    tools;
    constructor(options) {
        super();
        this.url = options.url || DEFAULT_URL;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.debug = options.debug ?? false;
    }
    log(...parts) {
        if (this.debug)
            console.error("[pi-affinity-mcp]", ...parts);
    }
    async ensure() {
        if (this.client?.isClosed)
            this.drop();
        if (this.client)
            return this.client;
        const client = new AffinityClient({
            url: this.url,
            timeoutMs: this.timeoutMs,
            debug: this.debug,
        });
        await client.connect();
        const info = (await client.handshake());
        this.log("connected", JSON.stringify(info.serverInfo ?? {}), "protocol", info.protocolVersion);
        this.client = client;
        this.primed = false;
        if (this.tools)
            await this.refreshTools(client);
        return client;
    }
    /** A new session may be a new Affinity version; tell listeners when its tools differ. */
    async refreshTools(client) {
        const tools = await client.listTools();
        if (JSON.stringify(tools) === JSON.stringify(this.tools))
            return;
        this.tools = tools;
        this.log("tool list changed");
        this.emit("toolsChanged");
    }
    drop() {
        this.client?.close();
        this.client = undefined;
        this.primed = false;
    }
    /**
     * Read the preamble in the current session; required before any SDK work.
     *
     * Observed on Affinity 3.3.3: a session can answer `File not found` for topics
     * while a freshly opened stream serves them, so a failed prime reconnects once
     * before the failure is reported.
     */
    async prime() {
        if (this.primed)
            return;
        for (let attempt = 1;; attempt += 1) {
            const client = await this.ensure();
            const result = await client.call(PREAMBLE_TOOL, { filename: PREAMBLE_TOPIC });
            const text = flatten(result);
            if (!result.isError) {
                this.primed = true;
                this.log("preamble primed", `(${text.length} chars)`);
                return;
            }
            if (attempt === 2) {
                throw new AffinityError(`could not read the SDK preamble: ${text.slice(0, 300)}. ` +
                    "Retry; if it persists, restart Affinity.");
            }
            this.log("preamble read failed, reconnecting once:", text.slice(0, 120));
            this.drop();
        }
    }
    async invoke(name, args) {
        const readsPreamble = name === PREAMBLE_TOOL && args.filename === PREAMBLE_TOPIC;
        if (GATED_TOOLS.has(name) && !readsPreamble)
            await this.prime();
        // Resolve the client after priming: priming may reconnect and replace it.
        let client = await this.ensure();
        let result = await client.call(name, args);
        if (isGateRefusal(result)) {
            this.log("preamble gate tripped -> re-priming and retrying", name);
            this.primed = false;
            await this.prime();
            client = await this.ensure();
            result = await client.call(name, args);
        }
        return result;
    }
    serialize(task) {
        const run = this.tail.then(task, task);
        this.tail = run.then(() => undefined, () => undefined);
        return run;
    }
    async callTool(name, args) {
        return await this.serialize(async () => {
            try {
                return await this.invoke(name, args);
            }
            catch (error) {
                if (!(error instanceof AffinityTimeoutError))
                    throw error;
                // The session did not answer in time; nothing more is sent on it.
                this.drop();
                if (!READ_ONLY_TOOLS.has(name)) {
                    throw new AffinityTimeoutError(`${name} did not answer within ${this.timeoutMs / 1000}s. It may still be running in ` +
                        "Affinity, or have finished: inspect the document before running it again. " +
                        "Long scripts need a longer --timeout (AFFINITY_MCP_TIMEOUT).");
                }
                this.log("timeout, reconnecting once:", error.message);
                return await this.invoke(name, args);
            }
        });
    }
    async listTools() {
        return await this.serialize(async () => {
            // Without a live session, reopen it first: that also refreshes a cached list.
            if (!this.tools || !this.client || this.client.isClosed) {
                const client = await this.ensure();
                this.tools ??= await client.listTools();
            }
            return this.tools;
        });
    }
    close() {
        this.drop();
    }
}
