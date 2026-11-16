import { readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
/** Honest version for `serverInfo`: whatever package.json says, never a hardcoded copy. */
export const VERSION = pkg.version;
export const SERVER_NAME = "pi-affinity-mcp";
