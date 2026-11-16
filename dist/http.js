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
import { createServer } from "node:http";
import { SERVER_NAME, VERSION } from "./version.js";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
export function isLoopback(host) {
    return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
/**
 * Browsers send `Origin` with every POST; other MCP clients send none. Only a page
 * served from this machine may call: anything else is a web page (or a DNS-rebinding
 * attack) trying to run scripts in Affinity through this bridge.
 */
export function isAllowedOrigin(origin) {
    if (origin === undefined)
        return true;
    try {
        return isLoopback(new URL(origin).hostname.replace(/^\[(.*)\]$/, "$1"));
    }
    catch {
        return false;
    }
}
function readBody(request) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        request.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error("request body too large"));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        request.on("error", reject);
    });
}
function json(response, status, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
    });
    response.end(body);
}
/** Refuses to expose an unauthenticated bridge beyond loopback. */
export function assertBindIsSafe(host, token) {
    if (isLoopback(host) || token)
        return;
    throw new Error(`refusing to listen on ${host} without a token: pass --token <secret> or AFFINITY_MCP_TOKEN`);
}
export function startHttpServer(core, options) {
    assertBindIsSafe(options.host, options.token);
    const authorized = (request) => {
        if (!options.token)
            return true;
        const header = request.headers.authorization ?? "";
        return header === `Bearer ${options.token}`;
    };
    const server = createServer((request, response) => {
        void (async () => {
            const path = (request.url ?? "/").split("?")[0];
            if (path === "/healthz") {
                json(response, 200, {
                    ok: true,
                    server: SERVER_NAME,
                    version: VERSION,
                    upstream: options.upstreamUrl,
                });
                return;
            }
            if (!isAllowedOrigin(request.headers.origin)) {
                json(response, 403, { error: "forbidden origin" });
                return;
            }
            if (!authorized(request)) {
                json(response, 401, { error: "unauthorized" });
                return;
            }
            if (path !== "/mcp" && path !== "/") {
                json(response, 404, { error: "not found; POST /mcp" });
                return;
            }
            // No server-initiated stream (GET) and no sessions to end (DELETE): the spec allows 405.
            if (request.method !== "POST") {
                response.writeHead(405, { allow: "POST" });
                response.end();
                return;
            }
            let body;
            try {
                body = await readBody(request);
            }
            catch (error) {
                json(response, 413, { error: error.message });
                return;
            }
            let parsed;
            try {
                parsed = JSON.parse(body);
            }
            catch {
                json(response, 400, {
                    jsonrpc: "2.0",
                    id: null,
                    error: { code: -32700, message: "parse error" },
                });
                return;
            }
            const batch = Array.isArray(parsed) ? parsed : [parsed];
            let responses;
            try {
                responses = await core.handleMany(batch);
            }
            catch (error) {
                json(response, 500, { error: error.message });
                return;
            }
            // Only notifications: nothing to return.
            if (responses.length === 0) {
                response.writeHead(202).end();
                return;
            }
            json(response, 200, Array.isArray(parsed) ? responses : responses[0]);
        })().catch((error) => {
            if (!response.headersSent)
                json(response, 500, { error: error.message });
            else
                response.end();
        });
    });
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, options.host, () => {
            server.removeListener("error", reject);
            resolve(server);
        });
    });
}
