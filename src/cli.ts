#!/usr/bin/env node
/**
 * pi-affinity-mcp — MCP server for Affinity by Canva.
 *
 * Default (no arguments) is the stdio MCP server: that is what pi, mcporter,
 * Claude Desktop and Codex spawn.
 */

import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { AffinityBridge } from "./bridge.js";
import { AffinityTimeoutError, flatten } from "./client.js";
import { startHttpServer } from "./http.js";
import { McpServerCore, runStdioServer } from "./mcp.js";
import { DEFAULT_TIMEOUT_MS, DEFAULT_URL } from "./protocol.js";
import { SERVER_NAME, VERSION } from "./version.js";

const HELP = `${SERVER_NAME} ${VERSION} — MCP server for Affinity by Canva

Usage:
  pi-affinity-mcp                     stdio MCP server (what MCP clients spawn)
  pi-affinity-mcp --http              streamable HTTP MCP server on 127.0.0.1:7767/mcp
  pi-affinity-mcp --selftest          check the app is reachable and scripting works
  pi-affinity-mcp --selftest --folder <dir>
                                      … and that the app reads a file it is given in <dir>
  pi-affinity-mcp --dump-docs <dir>   write the SDK documentation and tool schemas to <dir>

Options:
  --url <url>        Affinity SSE endpoint (default ${DEFAULT_URL})
  --timeout <s>      upstream request timeout in seconds (default ${DEFAULT_TIMEOUT_MS / 1000})
  --host <host>      HTTP bind address (default 127.0.0.1)
  --port <port>      HTTP port (default 7767)
  --token <secret>   bearer token required by --http (env AFFINITY_MCP_TOKEN)
  --tools <a,b,…>    offer only these tools and refuse the others (env AFFINITY_MCP_TOOLS)
  --close-documents  on SIGTERM or SIGINT, close the documents this server's scripts opened
  --debug            log protocol activity to stderr
  --version          print the version
  --help             print this help

Environment:
  AFFINITY_MCP_URL      same as --url
  AFFINITY_MCP_TIMEOUT  same as --timeout
  AFFINITY_MCP_TOKEN    same as --token
  AFFINITY_MCP_TOOLS    same as --tools
`;

type Options = {
  url: string;
  timeoutMs: number;
  debug: boolean;
  http: boolean;
  host: string;
  port: number;
  token?: string;
  tools?: ReadonlySet<string>;
  closeDocuments: boolean;
  selftest: boolean;
  folder?: string;
  dumpDocs?: string;
};

/** How long closing the documents may take when the server is told to stop. */
const CLOSE_DOCUMENTS_MS = 10_000;

function toolSet(value: string): ReadonlySet<string> {
  const names = value.split(",").map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) throw new Error("--tools needs at least one tool name");
  return new Set(names);
}

function parseArgs(argv: string[]): Options | "help" | "version" {
  const options: Options = {
    url: DEFAULT_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    debug: false,
    http: false,
    host: "127.0.0.1",
    port: 7767,
    token: process.env.AFFINITY_MCP_TOKEN,
    tools: process.env.AFFINITY_MCP_TOOLS ? toolSet(process.env.AFFINITY_MCP_TOOLS) : undefined,
    closeDocuments: false,
    selftest: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
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
      case "--tools":
        options.tools = toolSet(next());
        break;
      case "--close-documents":
        options.closeDocuments = true;
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
      case "--folder":
        options.folder = resolve(next());
        break;
      case "--dump-docs":
        options.dumpDocs = next();
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.folder !== undefined && !options.selftest) throw new Error("--folder goes with --selftest");
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

async function selftest(bridge: AffinityBridge, options: Options): Promise<number> {
  const tools = await bridge.listTools();
  console.log(`tools: ${tools.length}`);
  for (const tool of tools) console.log(` - ${String(tool.name)}`);
  const result = await bridge.callTool("execute_script", { script: VERSION_SCRIPT });
  const text = flatten(result);
  console.log(`execute_script isError: ${String(result.isError ?? false)}`);
  console.log(text.slice(0, 800));
  if (result.isError) return 1;
  return options.folder === undefined ? 0 : await readsFolder(bridge, options.folder, options.timeoutMs);
}

/**
 * Whether the app reads a file it is given in `folder`, as a session's scripts do. On a Mac the app does not answer
 * while macOS asks, on the machine's screen, whether it may read a protected folder (the Desktop, Documents,
 * Downloads); scripts that read nothing answer meanwhile, so only a read shows it.
 */
async function readsFolder(bridge: AffinityBridge, folder: string, timeoutMs: number): Promise<number> {
  const marker = randomUUID();
  const file = join(folder, `.selftest-${marker}.js`); // a name of its own: the app keeps what it once required
  const allow = "System Settings → Privacy & Security → Files and Folders → Affinity";
  await writeFile(file, `module.exports = ${JSON.stringify(marker)};\n`);
  try {
    const result = await bridge.callTool("execute_script", { script: `console.log(require(${JSON.stringify(file)}));` });
    const answer = flatten(result).trim();
    if (answer === marker) {
      console.log(`the app reads files in ${folder}`);
      return 0;
    }
    console.error(`the app could not read ${file}: ${answer.slice(0, 200)}. On a Mac, allow Affinity that folder in ${allow}.`);
    return 1;
  } catch (error) {
    if (!(error instanceof AffinityTimeoutError)) throw error;
    console.error(
      `the app did not read a file in ${folder} within ${timeoutMs / 1000} s. On a Mac, macOS may be asking on this ` +
        `machine's screen whether Affinity may read that folder: allow it there, or in ${allow}.`,
    );
    return 1;
  } finally {
    await rm(file, { force: true });
  }
}

async function dumpDocs(bridge: AffinityBridge, dir: string): Promise<number> {
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

async function main(argv: string[]): Promise<number> {
  let options: Options | "help" | "version";
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`[pi-affinity-mcp] ${(error as Error).message}`);
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
    ownDocuments: options.closeDocuments,
  });
  const shutdown = async (): Promise<void> => {
    if (options.closeDocuments) {
      const giveUp = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("timed out")), CLOSE_DOCUMENTS_MS).unref();
      });
      try {
        const closed = await Promise.race([bridge.closeDocuments(), giveUp]);
        console.error(`[pi-affinity-mcp] closed ${closed.length} document(s)`);
      } catch (error) {
        console.error(`[pi-affinity-mcp] documents left open: ${(error as Error).message}`);
      }
    }
    bridge.close();
    process.exit(0);
  };
  // A second signal while the documents close changes nothing: whoever stops this server may ask twice.
  let stopping: Promise<void> | undefined;
  const stop = (): void => {
    stopping ??= shutdown();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  try {
    if (options.selftest) return await selftest(bridge, options);
    if (options.dumpDocs) return await dumpDocs(bridge, options.dumpDocs);

    const core = new McpServerCore(bridge, { listChanged: !options.http, tools: options.tools });
    if (options.http) {
      const server = await startHttpServer(core, {
        host: options.host,
        port: options.port,
        token: options.token,
        upstreamUrl: options.url,
      });
      console.error(
        `[pi-affinity-mcp] listening on http://${options.host}:${options.port}/mcp (upstream ${options.url})`,
      );
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("close", resolveListen);
        server.once("error", rejectListen);
      });
      return 0;
    }

    await runStdioServer(core, bridge);
    return 0;
  } catch (error) {
    console.error(`[pi-affinity-mcp] ${(error as Error).message}`);
    return 1;
  } finally {
    bridge.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
