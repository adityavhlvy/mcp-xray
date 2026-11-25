# MCP X-Ray

See the protocol, not the log.

Point it at a public MCP endpoint and get a trace you can play back: every
frame, both directions, and the server-to-client callbacks most clients never
show you.

## What it does

| View | What it answers |
| --- | --- |
| Sequence | Who sent what, in what order, and how long each round trip took. |
| Peel inspector | The same frame as bytes, as JSON, as protocol, and as rendered payload. |
| Call tree | Which request caused which callback. Parent links are inferred from timing, and labelled as such. |
| Waterfall | Where the time went, per method. |
| Lifecycle | The MCP state machine, with the current state highlighted. |
| Surface | Which primitives the server actually implements, read from its capabilities. |

## What it does not do

It does not run stdio servers, and it does not complete OAuth. Paste a bearer
token for servers that need one. Everything else is a plain HTTP request you
could make with curl.

## Run locally

Two terminals, because Rsbuild does not run the API:

```bash
bun install
bun run dev:api     # http://localhost:3001
bun run dev         # http://localhost:3000
```

Rsbuild proxies `/api` to 3001, so the page works as deployed.

## Checks

```bash
bun run typecheck
bun run check        # frame parsing, SSE, redaction, SSRF guard, call tree
bun run scripts/e2e.ts   # the mock server and the inspector, in one process
```

The e2e run is the only proof that the callback path works: the mock server
sends `sampling/createMessage` mid-call, and the inspector answers it on a
second request while the first response is still open.

## Security

The inspector fetches URLs that strangers type in, so every hop is checked
before it is requested:

- `10/8`, `172.16/12`, `192.168/16`, `127/8`, `100.64/10`, `169.254/16`
- IPv6 loopback, link-local, unique-local, multicast, NAT64, documentation
- Cloud metadata hostnames, `.local`, `.internal`, `.svc`
- Redirects are followed by hand, and each hop is re-checked
- 1 MB per frame, 2 000 frames, 10 s per request, 30 s total

Tokens and secrets are redacted on the server, before the trace reaches the
browser. The redaction is visible, so nobody mistakes it for an empty value.

## Layout

| Layer | Folder | Responsibility |
| --- | --- | --- |
| Pure domain | `shared/` | Frame parsing, SSE, redaction, types. No IO. |
| Transport | `server/` | MCP session over Streamable HTTP, SSRF guard. |
| HTTP | `api/` | Inspect and mock endpoints. Thin. |
| UI | `src/` | React views. Imports `shared/` only. |
