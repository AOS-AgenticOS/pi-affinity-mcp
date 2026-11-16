/**
 * Minimal MCP client for the legacy HTTP+SSE transport Affinity speaks.
 *
 * The stream is the response channel: we GET the SSE endpoint, wait for the
 * `endpoint` event that tells us where to POST, then POST JSON-RPC requests and
 * read the responses off the stream. Nothing else is required, so this has no
 * dependencies.
 */
import { CLIENT_INFO_FALLBACK, } from "./types.js";
export class AffinityError extends Error {
}
export class AffinityTimeoutError extends AffinityError {
}
/** Affinity answered with a JSON-RPC error of its own, e.g. -32602 "Tool not found: …". */
export class AffinityRpcError extends AffinityError {
    code;
    data;
    constructor(code, message, data) {
        super(message);
        this.code = code;
        this.data = data;
    }
}
export class AffinityClient {
    url;
    timeoutMs;
    debug;
    controller = new AbortController();
    pending = new Map();
    endpoint;
    endpointWaiters = [];
    endpointRejecters = [];
    nextId = 0;
    closed = false;
    constructor(options) {
        this.url = options.url;
        this.timeoutMs = options.timeoutMs;
        this.debug = options.debug ?? false;
    }
    log(...parts) {
        if (this.debug)
            console.error("[pi-affinity-mcp]", ...parts);
    }
    /** True once the stream has ended: Affinity quit or restarted, and this session is gone. */
    get isClosed() {
        return this.closed;
    }
    /** Base URL without the `/sse` suffix, matching how Affinity advertises its POST endpoint. */
    base() {
        return this.url.replace(/\/sse\/?$/, "").replace(/\/$/, "");
    }
    async connect() {
        let response;
        try {
            response = await fetch(this.url, {
                headers: { accept: "text/event-stream" },
                signal: this.controller.signal,
            });
        }
        catch (error) {
            throw new AffinityError(`cannot reach ${this.url} (${error.message}). Is Affinity running with its MCP server enabled?`);
        }
        if (!response.ok || !response.body) {
            throw new AffinityError(`SSE connect failed: HTTP ${response.status} from ${this.url}`);
        }
        void this.readLoop(response.body);
        await this.waitForEndpoint();
        return this;
    }
    async readLoop(body) {
        const decoder = new TextDecoder();
        const reader = body.getReader();
        let buffer = "";
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                let newline = buffer.indexOf("\n");
                while (newline >= 0) {
                    const line = buffer.slice(0, newline).replace(/\r$/, "");
                    buffer = buffer.slice(newline + 1);
                    this.handleLine(line);
                    newline = buffer.indexOf("\n");
                }
            }
        }
        catch (error) {
            if (!this.closed)
                this.log("reader stopped:", error.message);
        }
        finally {
            this.closed = true;
            this.failAll(new AffinityError("SSE stream closed"));
            this.failEndpointWaiters(new AffinityError("SSE stream closed before the endpoint event"));
        }
    }
    handleLine(line) {
        if (!line.startsWith("data:"))
            return;
        const payload = line.slice(5).trim();
        if (!payload)
            return;
        // The endpoint event carries a bare path; some servers prefix it with `event: endpoint`.
        if (payload.startsWith("/")) {
            this.setEndpoint(payload);
            return;
        }
        let message;
        try {
            message = JSON.parse(payload);
        }
        catch {
            this.log("non-JSON frame", payload.slice(0, 200));
            return;
        }
        const id = message.id;
        // Progress notifications and server-initiated requests are not responses.
        if (typeof id !== "number")
            return;
        const entry = this.pending.get(id);
        if (!entry)
            return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        if (message.error) {
            const { code, message: text, data } = message.error;
            entry.reject(new AffinityRpcError(code, text, data));
            return;
        }
        entry.resolve((message.result ?? {}));
    }
    setEndpoint(endpoint) {
        if (this.endpoint)
            return;
        this.endpoint = endpoint;
        this.log("endpoint", endpoint);
        for (const resolve of this.endpointWaiters)
            resolve(endpoint);
        this.endpointWaiters = [];
        this.endpointRejecters = [];
    }
    waitForEndpoint() {
        if (this.endpoint)
            return Promise.resolve(this.endpoint);
        if (this.closed) {
            return Promise.reject(new AffinityError("SSE stream closed before the endpoint event"));
        }
        const budget = Math.min(this.timeoutMs, 15_000);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new AffinityError("no endpoint event from Affinity. Is the Affinity app running with its MCP server enabled?"));
            }, budget);
            this.endpointWaiters.push((endpoint) => {
                clearTimeout(timer);
                resolve(endpoint);
            });
            this.endpointRejecters.push((error) => {
                clearTimeout(timer);
                reject(error);
            });
        });
    }
    async post(message) {
        if (!this.endpoint)
            throw new AffinityError("not connected");
        const response = await fetch(this.base() + this.endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(message),
            signal: this.controller.signal,
        });
        await response.text();
        if (!response.ok)
            throw new AffinityError(`POST ${this.endpoint} -> HTTP ${response.status}`);
    }
    async request(method, params) {
        const id = ++this.nextId;
        const response = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new AffinityTimeoutError(`timeout after ${this.timeoutMs}ms waiting for ${method}`));
            }, this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
        });
        const message = { jsonrpc: "2.0", id, method };
        if (params !== undefined)
            message.params = params;
        try {
            // Affinity answers on the stream before the POST returns, so the answer
            // (an error included) must already be awaited while the POST is in flight.
            const [, result] = await Promise.all([this.post(message), response]);
            return result;
        }
        catch (error) {
            const entry = this.pending.get(id);
            if (entry) {
                this.pending.delete(id);
                clearTimeout(entry.timer);
            }
            throw error;
        }
    }
    async notify(method, params) {
        const message = { jsonrpc: "2.0", method };
        if (params !== undefined)
            message.params = params;
        await this.post(message);
    }
    async handshake() {
        let result;
        try {
            result = await this.request("initialize", {
                protocolVersion: CLIENT_INFO_FALLBACK.protocolVersion,
                capabilities: {},
                clientInfo: {
                    name: CLIENT_INFO_FALLBACK.name,
                    version: CLIENT_INFO_FALLBACK.version,
                },
            });
        }
        catch (error) {
            // A refused handshake is this bridge's problem, not an error in the downstream request.
            if (!(error instanceof AffinityRpcError))
                throw error;
            throw new AffinityError(`Affinity refused the handshake: ${error.message} ${JSON.stringify(error.data ?? {})}`);
        }
        await this.notify("notifications/initialized");
        return result;
    }
    async listTools() {
        const result = (await this.request("tools/list"));
        return result.tools ?? [];
    }
    async call(name, args = {}) {
        return await this.request("tools/call", { name, arguments: args });
    }
    close() {
        this.closed = true;
        this.controller.abort();
        this.failAll(new AffinityError("client closed"));
        this.failEndpointWaiters(new AffinityError("client closed"));
    }
    failAll(error) {
        for (const [id, entry] of this.pending) {
            clearTimeout(entry.timer);
            this.pending.delete(id);
            entry.reject(error);
        }
    }
    failEndpointWaiters(error) {
        for (const reject of this.endpointRejecters)
            reject(error);
        this.endpointRejecters = [];
        this.endpointWaiters = [];
    }
}
/** MCP tool results are a content list; join the text parts, summarise the rest. */
export function flatten(result) {
    if (!result)
        return "";
    const parts = [];
    const content = result.content;
    if (Array.isArray(content)) {
        for (const item of content) {
            if (item.type === "text") {
                parts.push(String(item.text ?? ""));
            }
            else {
                const size = typeof item.data === "string" ? item.data.length : 0;
                parts.push(`<${String(item.type)} content, ${size} b64 chars>`);
            }
        }
    }
    if (result.structuredContent !== undefined && result.structuredContent !== null) {
        parts.push(JSON.stringify(result.structuredContent, null, 2));
    }
    return parts.join("\n");
}
