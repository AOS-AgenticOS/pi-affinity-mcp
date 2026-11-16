/** Wire types shared by the client, the stdio server and the HTTP server. */
import { PROTOCOL_VERSION } from "./protocol.js";
import { VERSION } from "./version.js";
/**
 * Identity this bridge presents upstream. Affinity does not care about the name;
 * it does care that the protocol version is exactly the one it supports.
 */
export const CLIENT_INFO_FALLBACK = {
    name: "pi-affinity-mcp",
    version: VERSION,
    protocolVersion: PROTOCOL_VERSION,
};
