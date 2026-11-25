// Runs the mock server and the inspector against each other, in one process.
// This is the only way to prove the callback path works without deploying.
// Run with `bun run scripts/e2e.ts`.
import mockHandler from "../api/mock.js";
import inspectHandler from "../api/inspect.js";
import { assertPublicUrl, GuardError } from "../server/guard.js";

declare const Bun: {
  serve(options: { port: number; fetch: (request: Request) => Promise<Response> }): { port: number; stop(): void };
};

/**
 * A Vercel-shaped response. The handler writes into a stream, and the stream
 * is handed back as soon as the handler's synchronous prefix has run, so a
 * server-to-client callback can be answered while the response is still open.
 */
function makeRes() {
  const headers = new Headers();
  let status = 200;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(next) {
      controller = next;
    },
  });

  const write = (value: string) => {
    if (closed || !controller) return;
    controller.enqueue(encoder.encode(value));
  };

  const close = () => {
    if (closed || !controller) return;
    closed = true;
    controller.close();
  };

  const res = {
    setHeader: (key: string, value: string) => headers.set(key, value),
    status(code: number) {
      status = code;
      return res;
    },
    json(value: unknown) {
      headers.set("content-type", "application/json");
      write(JSON.stringify(value));
      close();
      return res;
    },
    send(value: string) {
      write(value);
      close();
      return res;
    },
    end(value?: string) {
      if (value) write(value);
      close();
      return res;
    },
    write,
    flushHeaders: () => undefined,
  };

  return { res, build: () => new Response(stream, { status, headers }) };
}

const server = Bun.serve({
  port: 0,
  async fetch(request: Request) {
    const url = new URL(request.url);
    const text = await request.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }

    const req = {
      method: request.method,
      url: url.pathname + url.search,
      headers: Object.fromEntries(request.headers),
      body: parsed,
      socket: { remoteAddress: "127.0.0.1" },
    };

    const { res, build } = makeRes();
    const handler = url.pathname === "/api/mock" ? mockHandler : url.pathname === "/api/inspect" ? inspectHandler : null;
    if (!handler) return new Response("not found", { status: 404 });

    // Not awaited: the response must be readable while the handler waits for a
    // callback that arrives on a second request.
    void handler(req as never, res as never).catch((error: unknown) => {
      console.error("handler failed", error);
      close();
    });

    return build();
  },
});

const base = `http://127.0.0.1:${server.port}`;
let failures = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failures++;
  console.log(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

interface InspectResult {
  trace: { frames: Array<{ method?: string; dir: string; kind: string }> } | null;
  error: string | null;
}

async function inspect(body: Record<string, unknown>): Promise<InspectResult> {
  const response = await fetch(`${base}/api/inspect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as InspectResult;
}

// The guard blocks loopback by design. The mock lives on loopback, so the
// harness opts in explicitly. A request body can never set this.
process.env.MCP_XRAY_ALLOW_LOOPBACK = "1";

const result = await inspect({ url: `${base}/api/mock` });
check("inspect returns a trace", result.trace !== null, result.error ?? "no trace");
check("handshake is recorded", result.trace?.frames.some((frame) => frame.method === "initialize") === true);
check("tools/list is recorded", result.trace?.frames.some((frame) => frame.method === "tools/list") === true);
check("resources/list is recorded", result.trace?.frames.some((frame) => frame.method === "resources/list") === true);
check("prompts/list is recorded", result.trace?.frames.some((frame) => frame.method === "prompts/list") === true);

const withCall = await inspect({ url: `${base}/api/mock`, callTool: "echo", toolArgs: { text: "hello" } });
check("tool call is recorded", withCall.trace?.frames.some((frame) => frame.method === "tools/call") === true);

const withCallback = await inspect({ url: `${base}/api/mock`, callTool: "summarize", toolArgs: { text: "the deploy failed" } });
const callback = withCallback.trace?.frames.find((frame) => frame.method === "sampling/createMessage");
check("server calls back into the client", callback !== undefined, withCallback.error ?? "no callback");
check("callback travels server to client", callback?.dir === "in");

const failing = await inspect({ url: `${base}/api/mock`, callTool: "fail" });
check("a failing tool still returns a trace", failing.trace !== null);
check("the error frame is recorded", failing.trace?.frames.some((frame) => frame.kind === "error") === true);

// The guard is tested directly, without the loopback seam, so the real
// behaviour is what gets asserted. The inspect path runs with the seam on,
// because the mock lives on loopback.
for (const [name, url] of [
  ["metadata", "http://169.254.169.254/latest/meta-data"],
  ["loopback", "http://127.0.0.1:3000/mcp"],
  ["private 10/8", "http://10.1.2.3/mcp"],
  ["private 192.168/16", "http://192.168.1.1/mcp"],
  ["localhost", "http://localhost:3000/mcp"],
  ["file scheme", "file:///etc/passwd"],
  ["credentials", "https://user:pass@example.com/mcp"],
] as const) {
  let rejected = false;
  try {
    await assertPublicUrl(url);
  } catch (error) {
    rejected = error instanceof GuardError;
  }
  check(`guard rejects ${name}`, rejected);
}

let allowed = false;
try {
  await assertPublicUrl("https://example.com/mcp");
  allowed = true;
} catch {
  allowed = false;
}
check("guard allows a public host", allowed);

server.stop();
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\ne2e passed");
