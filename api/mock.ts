import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * A deliberately small MCP server used by the trace textbook. It exists so the
 * viewer has something to show without asking the visitor to run anything, and
 * so the server-to-client callback can be demonstrated on demand.
 *
 * It is not a general purpose server. Every tool is a fixed scenario.
 */

const PROTOCOL_VERSION = "2025-06-18";

interface Pending {
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Callbacks in flight, keyed by the id the server chose. */
const pending = new Map<number, Pending>();
let nextCallbackId = 1000;

const TOOLS = [
  {
    name: "echo",
    title: "Echo",
    description: "Returns the text you send. The smallest possible tool.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to return." } },
      required: ["text"],
    },
  },
  {
    name: "add",
    title: "Add two numbers",
    description: "Adds two numbers. Shows a flat, typed input schema.",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
  {
    name: "search_notes",
    title: "Search notes",
    description: "Searches notes. Shows a nested object and an enum in the schema.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        filter: {
          type: "object",
          properties: {
            since: { type: "string", format: "date" },
            tags: { type: "array", items: { type: "string" } },
            sort: { type: "string", enum: ["relevance", "recent"] },
          },
        },
      },
      required: ["query"],
    },
  },
  {
    name: "summarize",
    title: "Summarize with the client model",
    description:
      "Asks the client to run sampling. This is the tool that makes the arrow point the other way.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "fail",
    title: "Fail on purpose",
    description: "Always returns a JSON-RPC error, so the error path can be seen.",
    inputSchema: { type: "object", properties: {} },
  },
];

const RESOURCES = [
  {
    uri: "notes://welcome",
    name: "Welcome note",
    description: "A short text resource.",
    mimeType: "text/plain",
  },
  {
    uri: "notes://config",
    name: "Config",
    description: "A JSON resource, to show a different mime type.",
    mimeType: "application/json",
  },
];

const PROMPTS = [
  {
    name: "review",
    title: "Review a diff",
    description: "A prompt with one required and one optional argument.",
    arguments: [
      { name: "diff", description: "The diff to review.", required: true },
      { name: "tone", description: "How blunt to be.", required: false },
    ],
  },
];

const ok = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const fail = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

function toolResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function runTool(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "echo":
      return toolResult(String(args.text ?? ""));
    case "add": {
      const a = Number(args.a);
      const b = Number(args.b);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return toolResult("Both a and b must be numbers.", true);
      return toolResult(String(a + b));
    }
    case "search_notes": {
      const query = String(args.query ?? "");
      const filter = (args.filter ?? {}) as { sort?: string };
      return toolResult(
        JSON.stringify(
          {
            query,
            sort: filter.sort ?? "relevance",
            results: [
              { title: "Deploy notes", score: 0.92 },
              { title: "Meeting notes", score: 0.71 },
            ],
          },
          null,
          2,
        ),
      );
    }
    case "summarize":
      return toolResult("Sampling is handled by the caller.");
    case "fail":
      return null;
    default:
      return null;
  }
}

function sse(res: VercelResponse, message: unknown) {
  res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, mcp-session-id, mcp-protocol-version, authorization");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "DELETE") return res.status(204).end();
  if (req.method === "GET") {
    // The spec allows a GET stream. The mock has nothing to push unprompted.
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    return res.status(200).end(": mcp-xray mock server\n\n");
  }
  if (req.method !== "POST") return res.status(405).json(fail(null, -32600, "Method not allowed"));

  const body = typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};
  const method = typeof body.method === "string" ? body.method : undefined;
  const id = body.id;

  // A response from the client, not a request. Resolve the callback.
  if (!method && id !== undefined && id !== null) {
    const entry = pending.get(Number(id));
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(Number(id));
      entry.resolve(body.result ?? body.error ?? null);
    }
    return res.status(202).end();
  }

  if (!method) return res.status(400).json(fail(id, -32600, "Invalid request"));

  if (method === "notifications/initialized" || method.startsWith("notifications/")) {
    return res.status(202).end();
  }

  if (method === "initialize") {
    res.setHeader("mcp-session-id", "mock-session");
    return res.status(200).json(
      ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          prompts: { listChanged: false },
          logging: {},
        },
        serverInfo: { name: "mcp-xray-mock", version: "0.1.0", title: "X-Ray Mock Server" },
        instructions: "A fixed server for the trace textbook. Every tool is a scenario.",
      }),
    );
  }

  if (method === "ping") return res.status(200).json(ok(id, {}));

  if (method === "tools/list") return res.status(200).json(ok(id, { tools: TOOLS }));
  if (method === "resources/list") return res.status(200).json(ok(id, { resources: RESOURCES }));
  if (method === "prompts/list") return res.status(200).json(ok(id, { prompts: PROMPTS }));

  if (method === "resources/read") {
    const uri = String((body.params as { uri?: string } | undefined)?.uri ?? "");
    if (uri === "notes://welcome") {
      return res.status(200).json(ok(id, { contents: [{ uri, mimeType: "text/plain", text: "Welcome to the mock server." }] }));
    }
    if (uri === "notes://config") {
      return res
        .status(200)
        .json(ok(id, { contents: [{ uri, mimeType: "application/json", text: '{"theme":"dark","pageSize":20}' }] }));
    }
    return res.status(200).json(fail(id, -32002, `Resource not found: ${uri}`));
  }

  if (method === "prompts/get") {
    const params = (body.params ?? {}) as { name?: string; arguments?: Record<string, string> };
    if (params.name !== "review") return res.status(200).json(fail(id, -32602, `Unknown prompt: ${params.name}`));
    const diff = params.arguments?.diff ?? "";
    const tone = params.arguments?.tone ?? "direct";
    return res.status(200).json(
      ok(id, {
        description: "Review a diff",
        messages: [
          {
            role: "user",
            content: { type: "text", text: `Review this diff in a ${tone} tone.\n\n${diff}` },
          },
        ],
      }),
    );
  }

  if (method === "tools/call") {
    const params = (body.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const name = params.name ?? "";
    const args = params.arguments ?? {};

    if (name === "fail") return res.status(200).json(fail(id, -32603, "This tool always fails. That is the point."));

    if (name === "summarize") {
      // Stream the callback, then the result, so the client sees the reverse arrow.
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      const text = String(args.text ?? "");
      const callbackId = nextCallbackId++;
      const request = {
        jsonrpc: "2.0",
        id: callbackId,
        method: "sampling/createMessage",
        params: {
          messages: [{ role: "user", content: { type: "text", text: `Summarize: ${text}` } }],
          maxTokens: 64,
        },
      };

      sse(res, request);
      const answer = await new Promise<unknown>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(callbackId);
          resolve({ role: "assistant", content: { type: "text", text: "[timeout] The client did not answer." } });
        }, 3_000);
        pending.set(callbackId, { resolve, timer });
      });

      const summary =
        typeof answer === "object" && answer !== null
          ? ((answer as { content?: { text?: string } }).content?.text ?? "(no text)")
          : "(no text)";

      sse(res, ok(id, toolResult(`The client said: ${summary}`)));
      return res.end();
    }

    const result = runTool(name, args);
    if (result === null) return res.status(200).json(fail(id, -32602, `Unknown tool: ${name}`));
    return res.status(200).json(ok(id, result));
  }

  return res.status(200).json(fail(id, -32601, `Method not found: ${method}`));
}
