#!/usr/bin/env node
/**
 * pi-affinity-mcp — MCP server for Affinity by Canva.
 *
 * Default (no arguments) is the stdio MCP server: that is what pi, mcporter,
 * Claude Desktop and Codex spawn.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { AffinityBridge } from "./bridge.js";
import { flatten } from "./client.js";
import { startHttpServer } from "./http.js";
import { McpServerCore, runStdioServer } from "./mcp.js";
import { DEFAULT_TIMEOUT_MS, DEFAULT_URL } from "./protocol.js";
import { SERVER_NAME, VERSION } from "./version.js";
const HELP = `${SERVER_NAME} ${VERSION} — MCP server for Affinity by Canva

Usage:
  pi-affinity-mcp                     stdio MCP server (what MCP clients spawn)
  pi-affinity-mcp --http              streamable HTTP MCP server on 127.0.0.1:7767/mcp
  pi-affinity-mcp --selftest          check the app is reachable and scripting works
  pi-affinity-mcp --dump-docs <dir>   write the SDK documentation and tool schemas to <dir>

Options:
  --url <url>        Affinity SSE endpoint (default ${DEFAULT_URL})
  --timeout <s>      upstream request timeout in seconds (default ${DEFAULT_TIMEOUT_MS / 1000})
  --host <host>      HTTP bind address (default 127.0.0.1)
  --port <port>      HTTP port (default 7767)
  --token <secret>   bearer token required by --http (env AFFINITY_MCP_TOKEN)
  --debug            log protocol activity to stderr
  --version          print the version
  --help             print this help

Environment:
  AFFINITY_MCP_URL      same as --url
  AFFINITY_MCP_TIMEOUT  same as --timeout
  AFFINITY_MCP_TOKEN    same as --token
`;
function parseArgs(argv) {
    const options = {
        url: DEFAULT_URL,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        debug: false,
        http: false,
        host: "127.0.0.1",
        port: 7767,
        token: process.env.AFFINITY_MCP_TOKEN,
        selftest: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = () => {
            const value = argv[index + 1];
            if (value === undefined)
                throw new Error(`${arg} needs a value`);
            index += 1;
            return value;
        };
        switch (arg) {
            case "--help":
            case "-h":
                return "help";
            case "--version":
                return "version";
            case "--url":
                options.url = next();
                break;
            case "--timeout":
                options.timeoutMs = Math.round(Number(next()) * 1000);
                break;
            case "--host":
                options.host = next();
                break;
            case "--port":
                options.port = Number(next());
                break;
            case "--token":
                options.token = next();
                break;
            case "--debug":
                options.debug = true;
                break;
            case "--http":
                options.http = true;
                break;
            case "--selftest":
                options.selftest = true;
                break;
            case "--dump-docs":
                options.dumpDocs = next();
                break;
            default:
                throw new Error(`unknown argument: ${arg}`);
        }
    }
    return options;
}
const VERSION_SCRIPT = [
    "const { Application } = require('/application.js');",
    "const { Document } = require('/document.js');",
    "console.log(JSON.stringify({",
    "  version: Application.version,",
    "  platform: Application.platformName,",
    "  documents: Document.all.map((d) => ({ name: d.name, sessionUuid: d.sessionUuid })),",
    "}));",
].join("\n");
async function selftest(bridge) {
    const tools = await bridge.listTools();
    console.log(`tools: ${tools.length}`);
    for (const tool of tools)
        console.log(` - ${String(tool.name)}`);
    const result = await bridge.callTool("execute_script", { script: VERSION_SCRIPT });
    const text = flatten(result);
    console.log(`execute_script isError: ${String(result.isError ?? false)}`);
    console.log(text.slice(0, 800));
    return result.isError ? 1 : 0;
}
async function dumpDocs(bridge, dir) {
    const target = resolve(dir);
    const docsDir = join(target, "sdk-docs");
    await mkdir(docsDir, { recursive: true });
    const tools = await bridge.listTools();
    await writeFile(join(target, "tools.json"), `${JSON.stringify(tools, null, 2)}\n`);
    console.error(`wrote ${tools.length} tool schemas`);
    const listing = await bridge.callTool("list_sdk_documentation", {});
    const topics = flatten(listing)
        .split(/[,\n]/)
        .map((topic) => topic.trim())
        .filter((topic) => topic.length > 0 && !topic.startsWith("SDK documentation"));
    await writeFile(join(target, "sdk-doc-topics.txt"), `${topics.join(", ")},\n`);
    console.error(`wrote ${topics.length} topic names`);
    let written = 0;
    for (const topic of topics) {
        const result = await bridge.callTool("read_sdk_documentation_topic", { filename: topic });
        if (result.isError) {
            console.error(`skipped ${topic}: ${flatten(result).slice(0, 120)}`);
            continue;
        }
        const path = join(docsDir, `${topic}.md`);
        await mkdir(dirname(path), { recursive: true });
        const body = flatten(result);
        await writeFile(path, body.endsWith("\n") ? body : `${body}\n`);
        written += 1;
    }
    console.error(`wrote ${written}/${topics.length} SDK documentation topics to ${docsDir}`);
    return 0;
}
async function main(argv) {
    let options;
    try {
        options = parseArgs(argv);
    }
    catch (error) {
        console.error(`[pi-affinity-mcp] ${error.message}`);
        console.error(HELP);
        return 2;
    }
    if (options === "help") {
        console.log(HELP);
        return 0;
    }
    if (options === "version") {
        console.log(VERSION);
        return 0;
    }
    const bridge = new AffinityBridge({
        url: options.url,
        timeoutMs: options.timeoutMs,
        debug: options.debug,
    });
    const shutdown = () => {
        bridge.close();
        process.exit(0);
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    try {
        if (options.selftest)
            return await selftest(bridge);
        if (options.dumpDocs)
            return await dumpDocs(bridge, options.dumpDocs);
        const core = new McpServerCore(bridge, { listChanged: !options.http });
        if (options.http) {
            const server = await startHttpServer(core, {
                host: options.host,
                port: options.port,
                token: options.token,
                upstreamUrl: options.url,
            });
            console.error(`[pi-affinity-mcp] listening on http://${options.host}:${options.port}/mcp (upstream ${options.url})`);
            await new Promise((resolveListen, rejectListen) => {
                server.once("close", resolveListen);
                server.once("error", rejectListen);
            });
            return 0;
        }
        await runStdioServer(core, bridge);
        return 0;
    }
    catch (error) {
        console.error(`[pi-affinity-mcp] ${error.message}`);
        return 1;
    }
    finally {
        bridge.close();
    }
}
process.exitCode = await main(process.argv.slice(2));
