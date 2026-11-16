# Changelog

Version headings follow the format pi and npm expect (`## [x.y.z]`).

## [0.2.0] - 2026-11-17

For a server that one agent's work owns (started for it, stopped after it).

- `--tools <a,b,…>` (`AFFINITY_MCP_TOOLS`): the server lists only these tools and refuses calls to the others. The
  limit is the server's own, so a client with direct access to it cannot call a hidden tool.
- `--close-documents`: the server records which documents its scripts opened and, on SIGTERM or SIGINT, closes those
  still open; documents a person opened in the app are never touched.
- The bearer token is compared in constant time.

## [0.1.0] - 2026-11-16

First release.

- `pi-affinity-mcp`: MCP server (stdio) for Affinity's local MCP server, with the
  SDK documentation gate handled for the client: one long-lived session, the
  preamble read before the first script or topic read, re-prime and retry when
  the gate trips, and a new session as soon as Affinity restarts.
- Affinity's tools pass through unchanged. Each new session re-reads the tool
  list; over stdio the client gets `notifications/tools/list_changed` when an
  Affinity update changed it.
- Timeouts never repeat an action: a read-only call is retried once on a fresh
  session; a script (or library save, hint, issue report) that outlived the
  timeout fails with a message saying it may still have run.
- Errors reach the model: a failed call (Affinity unreachable, timeout, refused
  handshake) is a tool result with `isError`; Affinity's own protocol errors,
  such as an unknown tool, pass through with their code.
- `pi-affinity-mcp --http`: streamable HTTP transport, so a client that cannot run
  on the same machine as Affinity (a container, a CI job, a remote dev box) can
  still reach it. Bearer token required beyond loopback; browser requests from
  other origins refused.
- `pi-affinity-mcp --selftest`: proves the app is reachable and that scripting
  works, in one command.
- `pi-affinity-mcp --dump-docs`: writes the SDK documentation and tool schemas to a
  local cache.
- Pi package: `extensions/register.ts` registers the server with
  `pi.registerMcpServer`, so installing the package is all a pi user does.
- `skills/mcp-affinity`: teaches the agent to work in Affinity — the workflow,
  the tools, script rules, SDK essentials, recipes, and what each error means.
