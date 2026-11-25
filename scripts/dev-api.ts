// Local API server for development. Rsbuild proxies /api here, the same way
// Vercel routes it in production. Run with `bun run dev:api`.
import mockHandler from "../api/mock.js";
import inspectHandler from "../api/inspect.js";

const PORT = Number(process.env.API_PORT ?? 3001);

declare const Bun: {
  serve(options: { port: number; fetch: (request: Request) => Promise<Response> }): { port: number; stop(): void };
};

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

Bun.serve({
  port: PORT,
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

    void handler(req as never, res as never).catch((error: unknown) => {
      console.error("handler failed", error);
    });

    return build();
  },
});

console.log(`api listening on http://localhost:${PORT}`);
