/**
 * Streamable HTTP transport (`--http`).
 *
 * Why it exists: Affinity listens on `[::1]:6767` inside its host. A client that
 * runs elsewhere — a container, a CI job, a remote dev box — cannot reach that
 * loopback. Running this bridge on the host and letting clients speak MCP over
 * HTTP fixes that without exposing Affinity itself.
 *
 * Deliberately stateless: no Mcp-Session-Id, no server-initiated stream. The
 * bridge holds the one long-lived upstream session; clients just POST.
 */
import { type Server } from "node:http";
import type { McpServerCore } from "./mcp.js";
export type HttpServerOptions = {
    host: string;
    port: number;
    /** Bearer token. Required when binding a non-loopback address. */
    token?: string;
    upstreamUrl: string;
};
export declare function isLoopback(host: string): boolean;
/**
 * Browsers send `Origin` with every POST; other MCP clients send none. Only a page
 * served from this machine may call: anything else is a web page (or a DNS-rebinding
 * attack) trying to run scripts in Affinity through this bridge.
 */
export declare function isAllowedOrigin(origin: string | undefined): boolean;
/** Refuses to expose an unauthenticated bridge beyond loopback. */
export declare function assertBindIsSafe(host: string, token: string | undefined): void;
export declare function startHttpServer(core: McpServerCore, options: HttpServerOptions): Promise<Server>;
