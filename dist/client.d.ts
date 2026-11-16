/**
 * Minimal MCP client for the legacy HTTP+SSE transport Affinity speaks.
 *
 * The stream is the response channel: we GET the SSE endpoint, wait for the
 * `endpoint` event that tells us where to POST, then POST JSON-RPC requests and
 * read the responses off the stream. Nothing else is required, so this has no
 * dependencies.
 */
import { type JsonRpcResult, type ToolsListResult } from "./types.js";
export declare class AffinityError extends Error {
}
export declare class AffinityTimeoutError extends AffinityError {
}
/** Affinity answered with a JSON-RPC error of its own, e.g. -32602 "Tool not found: …". */
export declare class AffinityRpcError extends AffinityError {
    readonly code: number;
    readonly data?: unknown | undefined;
    constructor(code: number, message: string, data?: unknown | undefined);
}
export type AffinityClientOptions = {
    url: string;
    timeoutMs: number;
    debug?: boolean;
};
export declare class AffinityClient {
    private readonly url;
    private readonly timeoutMs;
    private readonly debug;
    private readonly controller;
    private readonly pending;
    private endpoint?;
    private endpointWaiters;
    private endpointRejecters;
    private nextId;
    private closed;
    constructor(options: AffinityClientOptions);
    private log;
    /** True once the stream has ended: Affinity quit or restarted, and this session is gone. */
    get isClosed(): boolean;
    /** Base URL without the `/sse` suffix, matching how Affinity advertises its POST endpoint. */
    private base;
    connect(): Promise<this>;
    private readLoop;
    private handleLine;
    private setEndpoint;
    private waitForEndpoint;
    private post;
    request(method: string, params?: Record<string, unknown>): Promise<JsonRpcResult>;
    notify(method: string, params?: Record<string, unknown>): Promise<void>;
    handshake(): Promise<Record<string, unknown>>;
    listTools(): Promise<ToolsListResult["tools"]>;
    call(name: string, args?: Record<string, unknown>): Promise<JsonRpcResult>;
    close(): void;
    private failAll;
    private failEndpointWaiters;
}
/** MCP tool results are a content list; join the text parts, summarise the rest. */
export declare function flatten(result: Record<string, unknown> | undefined): string;
