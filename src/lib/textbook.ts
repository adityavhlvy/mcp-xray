import type { Frame, Trace } from "../../shared/types.js";

/**
 * Traces that ship with the app. They are recorded, not generated, so the
 * textbook works with no network and no server. Each one teaches one thing.
 */

interface Spec {
  t: number;
  dir: "out" | "in";
  msg: Record<string, unknown>;
}

function build(specs: Spec[]): Frame[] {
  return specs.map((spec, i) => {
    const raw = JSON.stringify(spec.msg);
    const method = typeof spec.msg.method === "string" ? spec.msg.method : undefined;
    const id = spec.msg.id as number | string | undefined;
    const kind = method ? (id === undefined || id === null ? "notification" : "request") : spec.msg.error ? "error" : "response";
    return {
      i,
      t: spec.t,
      dir: spec.dir,
      kind,
      id,
      method,
      raw,
      msg: spec.msg,
      bytes: new TextEncoder().encode(raw).length,
    } as Frame;
  });
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: { roots: { listChanged: true }, sampling: {}, elicitation: {} },
    clientInfo: { name: "mcp-xray", version: "0.1.0" },
  },
};

const INIT_RESULT = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    protocolVersion: "2025-06-18",
    capabilities: { tools: { listChanged: false }, resources: { subscribe: false }, prompts: { listChanged: false } },
    serverInfo: { name: "demo-server", version: "1.0.0", title: "Demo Server" },
  },
};

const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };

const TOOLS_LIST = {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/list",
};

const TOOLS_RESULT = {
  jsonrpc: "2.0",
  id: 2,
  result: {
    tools: [
      {
        name: "echo",
        description: "Returns the text you send.",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      },
      {
        name: "add",
        description: "Adds two numbers.",
        inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
      },
    ],
  },
};

const CALL = {
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "echo", arguments: { text: "hello" } },
};

const CALL_RESULT = {
  jsonrpc: "2.0",
  id: 3,
  result: { content: [{ type: "text", text: "hello" }] },
};

const SAMPLING = {
  jsonrpc: "2.0",
  id: 1000,
  method: "sampling/createMessage",
  params: {
    messages: [{ role: "user", content: { type: "text", text: "Summarize: the deploy failed" } }],
    maxTokens: 64,
  },
};

const SAMPLING_RESULT = {
  jsonrpc: "2.0",
  id: 1000,
  result: {
    role: "assistant",
    content: { type: "text", text: "The deploy failed." },
    model: "mcp-xray",
    stopReason: "endTurn",
  },
};

const SUMMARIZE_CALL = {
  jsonrpc: "2.0",
  id: 4,
  method: "tools/call",
  params: { name: "summarize", arguments: { text: "the deploy failed" } },
};

const SUMMARIZE_RESULT = {
  jsonrpc: "2.0",
  id: 4,
  result: { content: [{ type: "text", text: "The client said: The deploy failed." }] },
};

const RESOURCES_LIST = { jsonrpc: "2.0", id: 5, method: "resources/list" };
const RESOURCES_RESULT = {
  jsonrpc: "2.0",
  id: 5,
  result: {
    resources: [
      { uri: "notes://welcome", name: "Welcome note", mimeType: "text/plain" },
      { uri: "notes://config", name: "Config", mimeType: "application/json" },
    ],
  },
};

const PROMPTS_LIST = { jsonrpc: "2.0", id: 6, method: "prompts/list" };
const PROMPTS_RESULT = {
  jsonrpc: "2.0",
  id: 6,
  result: {
    prompts: [
      {
        name: "review",
        description: "Review a diff",
        arguments: [
          { name: "diff", required: true },
          { name: "tone", required: false },
        ],
      },
    ],
  },
};

const BAD_CALL = {
  jsonrpc: "2.0",
  id: 7,
  method: "tools/call",
  params: { name: "does_not_exist", arguments: {} },
};

const BAD_CALL_RESULT = {
  jsonrpc: "2.0",
  id: 7,
  error: { code: -32602, message: "Unknown tool: does_not_exist" },
};

const PING = { jsonrpc: "2.0", id: 8, method: "ping" };
const PING_RESULT = { jsonrpc: "2.0", id: 8, result: {} };

const PROGRESS = {
  jsonrpc: "2.0",
  method: "notifications/progress",
  params: { progressToken: "call-3", progress: 1, total: 2, message: "Halfway" },
};

const CANCELLED = {
  jsonrpc: "2.0",
  method: "notifications/cancelled",
  params: { requestId: 3, reason: "User pressed stop" },
};

const base = (frames: Frame[], target: string, server: Trace["server"]): Trace => ({
  version: 1,
  startedAt: "2026-11-25T09:00:00.000Z",
  target,
  transport: "mock",
  server,
  capabilities: { tools: {}, resources: {}, prompts: {} },
  frames,
});

export interface TextbookEntry {
  id: string;
  title: string;
  summary: string;
  teaches: string;
  trace: Trace;
}

export const TEXTBOOK: TextbookEntry[] = [
  {
    id: "minimal",
    title: "The smallest server",
    summary: "Handshake, then one list. Four frames.",
    teaches: "Every session starts with initialize, then the initialized notification. Nothing else is allowed before it.",
    trace: base(
      build([
        { t: 0, dir: "out", msg: INIT },
        { t: 42, dir: "in", msg: INIT_RESULT },
        { t: 44, dir: "out", msg: INITIALIZED },
        { t: 46, dir: "out", msg: TOOLS_LIST },
        { t: 61, dir: "in", msg: TOOLS_RESULT },
      ]),
      "https://demo.example.com/mcp",
      { name: "demo-server", version: "1.0.0", title: "Demo Server" },
    ),
  },
  {
    id: "call",
    title: "One tool call",
    summary: "A request, a result, and the content block inside it.",
    teaches: "tools/call returns content blocks, not a string. The type field is what the client renders.",
    trace: base(
      build([
        { t: 0, dir: "out", msg: INIT },
        { t: 38, dir: "in", msg: INIT_RESULT },
        { t: 40, dir: "out", msg: INITIALIZED },
        { t: 44, dir: "out", msg: TOOLS_LIST },
        { t: 58, dir: "in", msg: TOOLS_RESULT },
        { t: 120, dir: "out", msg: CALL },
        { t: 133, dir: "in", msg: CALL_RESULT },
      ]),
      "https://demo.example.com/mcp",
      { name: "demo-server", version: "1.0.0" },
    ),
  },
  {
    id: "callback",
    title: "The arrow points back",
    summary: "The server asks the client to run a model, mid-call.",
    teaches:
      "MCP is bidirectional. sampling/createMessage travels server to client, and the client answers on the same connection. Most people never see this.",
    trace: base(
      build([
        { t: 0, dir: "out", msg: INIT },
        { t: 40, dir: "in", msg: INIT_RESULT },
        { t: 42, dir: "out", msg: INITIALIZED },
        { t: 90, dir: "out", msg: SUMMARIZE_CALL },
        { t: 96, dir: "in", msg: SAMPLING },
        { t: 410, dir: "out", msg: SAMPLING_RESULT },
        { t: 415, dir: "in", msg: SUMMARIZE_RESULT },
      ]),
      "https://demo.example.com/mcp",
      { name: "demo-server", version: "1.0.0" },
    ),
  },
  {
    id: "resources",
    title: "Resources and prompts",
    summary: "The other two primitives, side by side.",
    teaches: "Resources are addressed by URI. Prompts are templates with arguments. Neither is a tool.",
    trace: base(
      build([
        { t: 0, dir: "out", msg: INIT },
        { t: 35, dir: "in", msg: INIT_RESULT },
        { t: 37, dir: "out", msg: INITIALIZED },
        { t: 50, dir: "out", msg: RESOURCES_LIST },
        { t: 66, dir: "in", msg: RESOURCES_RESULT },
        { t: 80, dir: "out", msg: PROMPTS_LIST },
        { t: 95, dir: "in", msg: PROMPTS_RESULT },
      ]),
      "https://demo.example.com/mcp",
      { name: "demo-server", version: "1.0.0" },
    ),
  },
  {
    id: "error",
    title: "A tool that does not exist",
    summary: "A JSON-RPC error, not an HTTP error.",
    teaches:
      "The HTTP status is 200. The failure lives in the error object. Clients that only check the status will show a blank result.",
    trace: base(
      build([
        { t: 0, dir: "out", msg: INIT },
        { t: 33, dir: "in", msg: INIT_RESULT },
        { t: 35, dir: "out", msg: INITIALIZED },
        { t: 60, dir: "out", msg: BAD_CALL },
        { t: 64, dir: "in", msg: BAD_CALL_RESULT },
      ]),
      "https://demo.example.com/mcp",
      { name: "demo-server", version: "1.0.0" },
    ),
  },
  {
    id: "progress",
    title: "Progress and cancellation",
    summary: "Notifications that arrive while a call is still open.",
    teaches:
      "Notifications have no id, so they cannot be answered. Cancellation is a notification too, which means the server may still send a result.",
    trace: base(
      build([
        { t: 0, dir: "out", msg: INIT },
        { t: 30, dir: "in", msg: INIT_RESULT },
        { t: 32, dir: "out", msg: INITIALIZED },
        { t: 100, dir: "out", msg: CALL },
        { t: 180, dir: "in", msg: PROGRESS },
        { t: 260, dir: "out", msg: CANCELLED },
        { t: 300, dir: "in", msg: CALL_RESULT },
      ]),
      "https://demo.example.com/mcp",
      { name: "demo-server", version: "1.0.0" },
    ),
  },
  {
    id: "ping",
    title: "Keeping the session alive",
    summary: "ping, and why a long-lived stream needs it.",
    teaches: "ping is the only method with no parameters and no side effects. It exists to prove the connection is still there.",
    trace: base(
      build([
        { t: 0, dir: "out", msg: INIT },
        { t: 28, dir: "in", msg: INIT_RESULT },
        { t: 30, dir: "out", msg: INITIALIZED },
        { t: 5_000, dir: "out", msg: PING },
        { t: 5_012, dir: "in", msg: PING_RESULT },
        { t: 10_000, dir: "out", msg: PING },
        { t: 10_009, dir: "in", msg: PING_RESULT },
      ]),
      "https://demo.example.com/mcp",
      { name: "demo-server", version: "1.0.0" },
    ),
  },
];
