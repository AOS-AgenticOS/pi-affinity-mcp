# pi-affinity-mcp

Lets AI agents work in **Affinity by Canva**: run JavaScript SDK scripts in the running app, read the SDK
documentation, and render spreads back as images to check the result.

It is an MCP server that sits between your agent and the MCP server built into Affinity. It works with pi
(installed as a package, together with a skill that teaches the agent how to work in Affinity), Claude
Desktop, Claude Code, Cursor, Codex, mcporter and any other MCP client — over stdio, or over HTTP for a
client on another machine.

## Why not connect to Affinity directly

- **pi cannot connect at all.** Affinity serves MCP over the legacy HTTP+SSE transport, which pi does not
  support.
- **Scripts never run from a one-shot connection.** Affinity refuses `execute_script` until the SDK
  preamble has been read in the same MCP session, so a client that opens a session per call can only list
  tools.

pi-affinity-mcp passes Affinity's tools through unchanged. It keeps one session open, reads the preamble
before the first script, opens a new session when Affinity restarts (and tells the client if the app
came back with different tools), and never sends a script twice: a script that outlives the timeout
fails and says it may still have run.

## Requirements

- Affinity 3 running on the same machine, with its MCP server enabled in Affinity's settings.
- Node.js 22 or newer.

## Install

```bash
npm install -g github:AOS-AgenticOS/pi-affinity-mcp
pi-affinity-mcp --selftest
```

`--selftest` lists the tools and runs one script in the app:

```
tools: 11
 - add_sdk_hint
 - execute_script
 …
execute_script isError: false
{"version":"Affinity 3.3.3.5004 MacOS (Oct 30 2026)","platform":"MacOS","documents":[]}
```

If it fails, Affinity is closed or its MCP server is switched off.

### pi

```bash
pi install git:github.com/AOS-AgenticOS/pi-affinity-mcp
```

The package registers the server with pi and adds the `mcp-affinity` skill; after a restart or `/reload`
the tools are available as `mcp__affinity__<tool>`. No `mcp.json` entry is needed, and the global
`npm install` above is not needed for pi either.

To try it for one session without installing: `pi -e ./path/to/pi-affinity-mcp`.

### Other MCP clients

Each client runs the `pi-affinity-mcp` command. If a desktop app cannot find it, use the full path that
`which pi-affinity-mcp` prints.

Claude Desktop (`claude_desktop_config.json`), Cursor (`.cursor/mcp.json`), mcporter, or pi's own
`~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "affinity": { "command": "pi-affinity-mcp" }
  }
}
```

Claude Code:

```bash
claude mcp add affinity -- pi-affinity-mcp
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.affinity]
command = "pi-affinity-mcp"
```

For agents other than pi, give them the skill too: copy `skills/mcp-affinity` into the agent's skills
folder (for example `~/.claude/skills/`), or add `SKILL.md` to its instructions.

### A client on another machine or in a container

Affinity only listens on its own machine. Run the bridge there over HTTP, with a token:

```bash
AFFINITY_MCP_TOKEN=$(openssl rand -hex 24) \
  pi-affinity-mcp --http --host 0.0.0.0 --port 7767
```

and point the client at it:

```json
{
  "mcpServers": {
    "affinity": {
      "url": "http://host.docker.internal:7767/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

## What the agent gets

| Tool | Does |
| --- | --- |
| `execute_script` | runs JavaScript in the app and returns what it logs |
| `render_spread`, `render_selection` | render a spread, or the selection, as a JPEG |
| `list_sdk_documentation`, `read_sdk_documentation_topic` | the SDK reference, served by the app |
| `search_sdk_hints`, `add_sdk_hint` | read and add hints shared across sessions |
| `list_library_scripts`, `read_library_script`, `save_script_to_library` | the app's script library |
| `report_sdk_issue` | send an SDK bug report to the Affinity team |

The [`mcp-affinity` skill](skills/mcp-affinity/SKILL.md) teaches the agent how to use them: inspect
first, look the API up, run one script per step, check with a render. It also carries the SDK essentials
and the rules that keep the user's work safe, such as never closing a document the agent did not create.
[`examples/`](examples) has four scripts you can run with `execute_script`.

## Command line

```
pi-affinity-mcp                     stdio MCP server (what MCP clients run)
pi-affinity-mcp --http              streamable HTTP MCP server, default 127.0.0.1:7767/mcp
pi-affinity-mcp --selftest          check that the app is reachable and scripts run
pi-affinity-mcp --dump-docs <dir>   save the SDK documentation and tool schemas to <dir>
```

| Option | Meaning |
| --- | --- |
| `--url <url>` | Affinity's MCP endpoint, default `http://[::1]:6767/sse` |
| `--timeout <s>` | how long a call may take, default 60; raise it for long scripts |
| `--host`, `--port` | HTTP address and port, default `127.0.0.1:7767` |
| `--token <secret>` | bearer token for `--http` |
| `--tools <a,b,…>` | offer only these tools; calls to any other are refused |
| `--close-documents` | when told to stop (SIGTERM, SIGINT), close the documents its scripts opened |
| `--debug` | log protocol traffic to stderr |

Environment variables: `AFFINITY_MCP_URL`, `AFFINITY_MCP_TIMEOUT`, `AFFINITY_MCP_TOKEN`, `AFFINITY_MCP_TOOLS`.

`--dump-docs reference` saves the SDK documentation from your Affinity installation for offline reading.
The documentation is Canva's, so this repository does not include it, and `reference/` is git-ignored.

## Security

- Scripts run inside Affinity with the permissions you gave scripts in Affinity's settings. When AI, file
  or network access is restricted there, the tools answer `NOT_ALLOWED`; the bridge does not work around
  it.
- `--http` on `127.0.0.1` needs no token; any other address requires one, and requests without it get
  `401`. `GET /healthz` answers without a token, for health checks.
- `--http` refuses (`403`) requests from a web page on another origin, so a site you visit cannot run
  scripts in Affinity through it.
- Some of Affinity's tools send what the agent wrote to Canva (`search_sdk_hints`, `add_sdk_hint`,
  `report_sdk_issue`). `--tools` leaves them out: the server then refuses them whatever the client asks.
- No telemetry, and no network traffic other than to the Affinity endpoint.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `cannot reach … Is Affinity running` | Affinity closed, or its MCP server off | start Affinity, enable its MCP server |
| `The preamble documentation topic has not yet been read.` | the client talks to Affinity directly | point the client at `pi-affinity-mcp` |
| `Affinity refused the handshake` | Affinity moved to a newer MCP protocol | update pi-affinity-mcp |
| `could not read the SDK preamble: File not found` | Affinity answered without its documentation | it retries once by itself; restart Affinity if it persists |
| `execute_script did not answer within 60s` | the script took longer than the timeout | check the document, then raise `--timeout` |
| `NOT_ALLOWED` | restricted in Affinity's settings | change the setting |
| HTTP `401` / `403` / `405` | no token / web-page origin / not a `POST` | send the token / call from an MCP client / `POST /mcp` |

## Development

```bash
npm install
npm run check          # build, type-check the pi extension, run the tests
```

The tests run against a fake Affinity server that behaves like the real one (legacy SSE transport, the
per-session preamble gate, its error answers), so they need neither a Mac nor Affinity. `--selftest`
covers the live app.

`dist/` is committed because `pi install git:…` does not run a build. `npm run verify:dist` fails when
`dist/` is out of date, and CI runs it.

Source: `src/client.ts` (connection to Affinity), `src/bridge.ts` (session, preamble, reconnects),
`src/mcp.ts` (MCP server, stdio), `src/http.ts` (HTTP transport), `src/cli.ts`, `extensions/register.ts`
(pi registration), `skills/mcp-affinity` (the agent skill).

## License

MIT for this project's code. Affinity and its SDK documentation belong to Canva — see [NOTICE](NOTICE).
