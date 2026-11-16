/**
 * Minimal MCP client for the legacy HTTP+SSE transport Affinity speaks.
 *
 * The stream is the response channel: we GET the SSE endpoint, wait for the
 * `endpoint` event that tells us where to POST, then POST JSON-RPC requests and
 * read the responses off the stream. Nothing else is required, so this has no
 * dependencies.
 */

import {
  CLIENT_INFO_FALLBACK,
  type JsonRpcResult,
  type ToolsListResult,
} from "./types.js";

export class AffinityError extends Error {}
export class AffinityTimeoutError extends AffinityError {}

/** Affinity answered with a JSON-RPC error of its own, e.g. -32602 "Tool not found: …". */
export class AffinityRpcError extends AffinityError {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

type Pending = {
  resolve: (result: JsonRpcResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type AffinityClientOptions = {
  url: string;
  timeoutMs: number;
  debug?: boolean;
};

export class AffinityClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly debug: boolean;
  private readonly controller = new AbortController();
  private readonly pending = new Map<number, Pending>();
  private endpoint?: string;
  private endpointWaiters: Array<(endpoint: string) => void> = [];
  private endpointRejecters: Array<(error: Error) => void> = [];
  private nextId = 0;
  private closed = false;

  constructor(options: AffinityClientOptions) {
    this.url = options.url;
    this.timeoutMs = options.timeoutMs;
    this.debug = options.debug ?? false;
  }

  private log(...parts: unknown[]): void {
    if (this.debug) console.error("[pi-affinity-mcp]", ...parts);
  }

  /** True once the stream has ended: Affinity quit or restarted, and this session is gone. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Base URL without the `/sse` suffix, matching how Affinity advertises its POST endpoint. */
  private base(): string {
    return this.url.replace(/\/sse\/?$/, "").replace(/\/$/, "");
  }

  async connect(): Promise<this> {
    let response: Response;
    try {
      response = await fetch(this.url, {
        headers: { accept: "text/event-stream" },
        signal: this.controller.signal,
      });
    } catch (error) {
      throw new AffinityError(
        `cannot reach ${this.url} (${(error as Error).message}). Is Affinity running with its MCP server enabled?`,
      );
    }
    if (!response.ok || !response.body) {
      throw new AffinityError(`SSE connect failed: HTTP ${response.status} from ${this.url}`);
    }
    void this.readLoop(response.body);
    await this.waitForEndpoint();
    return this;
  }

  private async readLoop(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          this.handleLine(line);
          newline = buffer.indexOf("\n");
        }
      }
    } catch (error) {
      if (!this.closed) this.log("reader stopped:", (error as Error).message);
    } finally {
      this.closed = true;
      this.failAll(new AffinityError("SSE stream closed"));
      this.failEndpointWaiters(new AffinityError("SSE stream closed before the endpoint event"));
    }
  }

  private handleLine(line: string): void {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    // The endpoint event carries a bare path; some servers prefix it with `event: endpoint`.
    if (payload.startsWith("/")) {
      this.setEndpoint(payload);
      return;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      this.log("non-JSON frame", payload.slice(0, 200));
      return;
    }
    const id = message.id;
    // Progress notifications and server-initiated requests are not responses.
    if (typeof id !== "number") return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (message.error) {
      const { code, message: text, data } = message.error as { code: number; message: string; data?: unknown };
      entry.reject(new AffinityRpcError(code, text, data));
      return;
    }
    entry.resolve((message.result ?? {}) as JsonRpcResult);
  }

  private setEndpoint(endpoint: string): void {
    if (this.endpoint) return;
    this.endpoint = endpoint;
    this.log("endpoint", endpoint);
    for (const resolve of this.endpointWaiters) resolve(endpoint);
    this.endpointWaiters = [];
    this.endpointRejecters = [];
  }

  private waitForEndpoint(): Promise<string> {
    if (this.endpoint) return Promise.resolve(this.endpoint);
    if (this.closed) {
      return Promise.reject(new AffinityError("SSE stream closed before the endpoint event"));
    }
    const budget = Math.min(this.timeoutMs, 15_000);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new AffinityError(
            "no endpoint event from Affinity. Is the Affinity app running with its MCP server enabled?",
          ),
        );
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

  private async post(message: Record<string, unknown>): Promise<void> {
    if (!this.endpoint) throw new AffinityError("not connected");
    const response = await fetch(this.base() + this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
      signal: this.controller.signal,
    });
    await response.text();
    if (!response.ok) throw new AffinityError(`POST ${this.endpoint} -> HTTP ${response.status}`);
  }

  async request(method: string, params?: Record<string, unknown>): Promise<JsonRpcResult> {
    const id = ++this.nextId;
    const response = new Promise<JsonRpcResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AffinityTimeoutError(`timeout after ${this.timeoutMs}ms waiting for ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    const message: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;
    try {
      // Affinity answers on the stream before the POST returns, so the answer
      // (an error included) must already be awaited while the POST is in flight.
      const [, result] = await Promise.all([this.post(message), response]);
      return result;
    } catch (error) {
      const entry = this.pending.get(id);
      if (entry) {
        this.pending.delete(id);
        clearTimeout(entry.timer);
      }
      throw error;
    }
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    const message: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    await this.post(message);
  }

  async handshake(): Promise<Record<string, unknown>> {
    let result: JsonRpcResult;
    try {
      result = await this.request("initialize", {
        protocolVersion: CLIENT_INFO_FALLBACK.protocolVersion,
        capabilities: {},
        clientInfo: {
          name: CLIENT_INFO_FALLBACK.name,
          version: CLIENT_INFO_FALLBACK.version,
        },
      });
    } catch (error) {
      // A refused handshake is this bridge's problem, not an error in the downstream request.
      if (!(error instanceof AffinityRpcError)) throw error;
      throw new AffinityError(
        `Affinity refused the handshake: ${error.message} ${JSON.stringify(error.data ?? {})}`,
      );
    }
    await this.notify("notifications/initialized");
    return result;
  }

  async listTools(): Promise<ToolsListResult["tools"]> {
    const result = (await this.request("tools/list")) as ToolsListResult;
    return result.tools ?? [];
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<JsonRpcResult> {
    return await this.request("tools/call", { name, arguments: args });
  }

  close(): void {
    this.closed = true;
    this.controller.abort();
    this.failAll(new AffinityError("client closed"));
    this.failEndpointWaiters(new AffinityError("client closed"));
  }

  private failAll(error: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(error);
    }
  }

  private failEndpointWaiters(error: Error): void {
    for (const reject of this.endpointRejecters) reject(error);
    this.endpointRejecters = [];
    this.endpointWaiters = [];
  }
}

/** MCP tool results are a content list; join the text parts, summarise the rest. */
export function flatten(result: Record<string, unknown> | undefined): string {
  if (!result) return "";
  const parts: string[] = [];
  const content = result.content;
  if (Array.isArray(content)) {
    for (const item of content as Array<Record<string, unknown>>) {
      if (item.type === "text") {
        parts.push(String(item.text ?? ""));
      } else {
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
