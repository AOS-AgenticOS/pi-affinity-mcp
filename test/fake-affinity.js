/**
 * A stand-in for Affinity's MCP server, so the CI proof does not need a Mac with
 * Affinity open. Every behaviour below was observed on Affinity 3.3.3.5004 (macOS):
 *
 *  - legacy HTTP+SSE, CRLF line endings, an `endpoint` event naming /message?session_id=…,
 *  - protocol 2025-11-25 only (-32602 with the supported list otherwise),
 *  - the preamble gate is per session: execute_script refuses with isError: true, a topic
 *    read refuses as plain text prefixed "ERROR: " with isError: false,
 *  - the answer to a POST arrives on the stream before the POST itself returns,
 *  - an unknown tool is a JSON-RPC error (-32602 "Tool not found: …"),
 *  - render_* and list_library_scripts are not gated,
 *  - a POST to a closed or unknown session is accepted (202) and never answered.
 */

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";

/** `require` of a file of the user's, by its absolute path; the SDK's own modules are `/<name>.js`. */
const FILE_REQUIRE = /require\(("\/[^"]+\/[^"]+")\)/;
const requireFile = createRequire(import.meta.url);

export const GATE_REFUSAL = "The preamble documentation topic has not yet been read.";

export const FAKE_DOCUMENT = "FAKE-DOC-UUID";

const TOPICS = ["application.js", "document.js", "preamble", "shapes.js"];

export const FAKE_TOOLS = [
  {
    name: "list_sdk_documentation",
    description: "List SDK documentation topics.",
    inputSchema: { type: "object" },
  },
  {
    name: "read_sdk_documentation_topic",
    description: "Read SDK documentation topic.",
    inputSchema: {
      type: "object",
      properties: { filename: { type: "string" } },
      required: ["filename"],
    },
  },
  {
    name: "execute_script",
    description: "Execute Javascript and return the results.",
    inputSchema: {
      type: "object",
      properties: { script: { type: "string" } },
      required: ["script"],
    },
  },
  {
    name: "list_library_scripts",
    description: "List the names of the scripts in the script library.",
    inputSchema: { type: "object" },
  },
  {
    name: "render_spread",
    description: "Render a spread to a base64 encoded JPEG.",
    inputSchema: {
      type: "object",
      properties: {
        document_session_uuid: { type: "string" },
        spread_index: { type: "number" },
      },
      required: ["document_session_uuid", "spread_index"],
    },
  },
];

const text = (value, isError = false) => ({ isError, content: [{ type: "text", text: value }] });

export async function startFakeAffinity() {
  /** session id -> { stream, primed } */
  const sessions = new Map();
  const state = {
    /** Tool calls in arrival order; topic reads as `read_sdk_documentation_topic(<filename>)`. */
    calls: [],
    /** Scripts that actually ran, including those whose answer was never sent. */
    executions: 0,
    toolsListCalls: 0,
    connections: 0,
    /** POSTs that arrived for a closed or unknown session. */
    deadPosts: 0,
    /** Tool name -> number of upcoming calls to run but never answer. */
    stall: {},
    /** Number of preamble reads to refuse with the app-side "File not found". */
    failPrimingOnce: 0,
    /** Number of upcoming streams to end before the endpoint event. */
    dropNextStreams: 0,
    /** The one protocol version the app accepts. */
    protocolVersion: "2025-11-25",
    /** What tools/list answers; an app update can change it. */
    tools: [...FAKE_TOOLS],
    /** Session UUIDs of the open documents. */
    documents: [],
    /** What a script that is not the bridge's own bookkeeping does to the app (a test sets it). */
    onScript: () => {},
    /** How long the app takes to answer a message, in milliseconds. */
    answerMs: 0,
    /** A script that reads a file runs but is never answered, as while macOS asks whether the app may read its folder. */
    unreadable: false,
  };

  /** The bridge's own scripts read and close documents; a script that `require`s a file reads it; every other script
   * is the client's. */
  const runScript = (script) => {
    if (script.includes("Document.all.map((d) => d.sessionUuid)")) return JSON.stringify(state.documents);
    const file = FILE_REQUIRE.exec(script);
    if (file) {
      try {
        return String(requireFile(JSON.parse(file[1])));
      } catch (error) {
        return `Error: ${error.message}`; // the app prints a script's exception as its answer
      }
    }
    const own = /const own = new Set\((\[.*?\])\);/.exec(script);
    if (own) {
      const closed = state.documents.filter((uuid) => JSON.parse(own[1]).includes(uuid));
      state.documents = state.documents.filter((uuid) => !closed.includes(uuid));
      return JSON.stringify(closed);
    }
    state.onScript(script);
    return JSON.stringify({ version: "Affinity fake", documents: [] });
  };

  const handleCall = (session, name, args) => {
    state.calls.push(
      name === "read_sdk_documentation_topic" ? `${name}(${String(args.filename)})` : name,
    );
    switch (name) {
      case "list_sdk_documentation":
        return text(`${TOPICS.join(", ")}, `);
      case "read_sdk_documentation_topic":
        if (args.filename === "preamble") {
          if (state.failPrimingOnce > 0) {
            state.failPrimingOnce -= 1;
            return text("File not found", true);
          }
          session.primed = true;
          return text("System preamble: read me first.");
        }
        if (!session.primed) return text(`ERROR: ${GATE_REFUSAL}`);
        if (!TOPICS.includes(args.filename)) return text("File not found", true);
        return text(`documentation for ${args.filename}`);
      case "execute_script":
        if (!session.primed) return text(GATE_REFUSAL, true);
        state.executions += 1;
        return text(`${runScript(String(args.script))}\n`);
      case "list_library_scripts":
        return text("");
      case "render_spread":
        if (args.document_session_uuid !== FAKE_DOCUMENT) {
          return text("No document with that Uuid exists.", true);
        }
        return { isError: false, content: [{ type: "image", mimeType: "image/jpeg", data: "AAAA" }] };
      default:
        return undefined;
    }
  };

  /** Returns the JSON-RPC response for one message, or undefined when nothing is sent. */
  const respond = (session, message) => {
    const { id, method, params } = message;
    const ok = (result) => ({ jsonrpc: "2.0", id, result });
    const error = (code, errorMessage, data) => ({
      jsonrpc: "2.0",
      id,
      error: { code, message: errorMessage, ...(data ? { data } : {}) },
    });

    if (method === "initialize") {
      if (params?.protocolVersion !== state.protocolVersion) {
        return error(-32602, "Unsupported protocol version", {
          supported: [state.protocolVersion],
          requested: params?.protocolVersion,
        });
      }
      return ok({
        protocolVersion: state.protocolVersion,
        serverInfo: { name: "Affinity", version: "1.0.0" },
        capabilities: { tools: {} },
      });
    }
    if (method === "notifications/initialized") return undefined;
    if (method === "tools/list") {
      state.toolsListCalls += 1;
      return ok({ tools: state.tools });
    }
    if (method === "tools/call") {
      const name = params?.name;
      const result = handleCall(session, name, params?.arguments ?? {});
      if (result === undefined) return error(-32602, `Tool not found: ${String(name)}`);
      if (state.stall[name] > 0) {
        state.stall[name] -= 1;
        return undefined;
      }
      if (state.unreadable && FILE_REQUIRE.test(String(params?.arguments?.script))) return undefined;
      return ok(result);
    }
    return error(-32601, `Method not found: ${String(method)}`);
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "GET" && url.pathname === "/sse") {
      state.connections += 1;
      const id = randomUUID();
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (state.dropNextStreams > 0) {
        state.dropNextStreams -= 1;
        response.end();
        return;
      }
      sessions.set(id, { stream: response, primed: false });
      response.write(`event: endpoint\r\ndata: /message?session_id=${id}\r\n\r\n`);
      request.on("close", () => sessions.delete(id));
      return;
    }

    if (request.method === "POST" && url.pathname === "/message") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const session = sessions.get(url.searchParams.get("session_id") ?? "");
        if (!session) {
          state.deadPosts += 1;
        } else {
          let message;
          try {
            message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            message = undefined;
          }
          const answer = message && respond(session, message);
          if (answer) setTimeout(() => session.stream.write(`event: message\r\ndata: ${JSON.stringify(answer)}\r\n\r\n`), state.answerMs);
        }
        // Affinity's answer is on the stream before the POST returns.
        setTimeout(() => response.writeHead(202).end("Accepted"), 20);
      });
      return;
    }

    response.writeHead(404).end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/sse`,
    state,
    /** The app lost every session's priming but kept the streams open. */
    forgetPriming() {
      for (const session of sessions.values()) session.primed = false;
    },
    /** The app quit: every stream ends, every session is gone. */
    closeStreams() {
      for (const session of sessions.values()) session.stream.end();
      sessions.clear();
    },
    async close() {
      this.closeStreams();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
