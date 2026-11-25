import { makeFrame, linkLatency, messagesFromBody, parseMessage, parseSse } from "../shared/frame.js";
import type { JsonRpcMessage } from "../shared/frame.js";
import type { Frame, ServerInfo, Trace, Transport } from "../shared/types.js";
import { MAX_FRAME_BYTES, MAX_FRAMES, REQUEST_TIMEOUT_MS, TOTAL_TIMEOUT_MS } from "../shared/types.js";
import { assertPublicUrl, GuardError, resolveRedirects } from "./guard.js";

export interface SessionOptions {
  endpoint: string;
  /** Bearer token, or any extra headers the server needs. */
  headers?: Record<string, string>;
  /** Client identity announced during initialize. */
  clientName?: string;
  clientVersion?: string;
  /** Test seam only. Never set from a request body. */
  allowPrivate?: boolean;
}

interface Pending {
  id: number;
  method: string;
  startedAt: number;
}

/**
 * A minimal MCP client over Streamable HTTP. It records every message it
 * sends and receives, including the server-to-client requests that arrive
 * inside an event stream, which is the part most inspectors miss.
 */
export class Session {
  private readonly frames: Frame[] = [];
  private readonly notes: string[] = [];
  private readonly startedAt = Date.now();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private sessionId: string | null = null;
  private protocolVersion = "2025-06-18";
  private server: ServerInfo | undefined;
  private capabilities: Record<string, unknown> | undefined;
  private clientCapabilities: Record<string, unknown> | undefined;
  private transport: Transport = "http";
  private closed = false;

  constructor(private readonly options: SessionOptions) {}

  get frameCount(): number {
    return this.frames.length;
  }

  private record(dir: "out" | "in", raw: string, timing?: Frame["timing"]): Frame {
    if (this.frames.length >= MAX_FRAMES) throw new GuardError(`Trace is limited to ${MAX_FRAMES} frames.`);
    if (raw.length > MAX_FRAME_BYTES) throw new GuardError(`A single message exceeded ${MAX_FRAME_BYTES} bytes.`);

    const frame = makeFrame({ i: this.frames.length, t: Date.now() - this.startedAt, dir, raw });
    if (timing) frame.timing = timing;
    this.frames.push(frame);
    return frame;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.options.headers,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    if (this.protocolVersion) headers["mcp-protocol-version"] = this.protocolVersion;
    return headers;
  }

  private async post(body: unknown): Promise<{ response: Response; timing: Frame["timing"] }> {
    const options = { allowPrivate: this.options.allowPrivate === true };
    const safe = await assertPublicUrl(this.options.endpoint, options);
    const payload = JSON.stringify(body);
    this.record("out", payload);

    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const { response } = await resolveRedirects(
        safe.url,
        (url) =>
          fetch(url, {
            method: "POST",
            headers: this.headers(),
            body: payload,
            signal: controller.signal,
            redirect: "manual",
          }),
        options,
      );

      const ttfb = performance.now() - started;
      const session = response.headers.get("mcp-session-id");
      if (session) this.sessionId = session;

      return { response, timing: { ttfb: Math.round(ttfb) } };
    } catch (error) {
      if (error instanceof GuardError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new GuardError(`The server did not answer within ${REQUEST_TIMEOUT_MS / 1000}s.`);
      }
      throw new GuardError(`Could not reach the server: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Reads the body, records every message, and answers server callbacks.
   *
   * An event stream is read incrementally, not with `text()`. A server that
   * asks the client to sample mid-call keeps the response open until the
   * answer arrives, so buffering the whole body would deadlock.
   */
  private async drain(response: Response, timing: Frame["timing"]): Promise<JsonRpcMessage[]> {
    const contentType = response.headers.get("content-type");
    const streaming = contentType?.includes("text/event-stream") === true;
    if (streaming) this.transport = "sse";

    const parsed: JsonRpcMessage[] = [];

    const handle = async (raw: string) => {
      const frame = this.record("in", raw, timing);
      const message = parseMessage(raw);
      if (!message) return;
      parsed.push(message);

      // A server may call back into the client mid-stream. Answering here is
      // what makes the reverse arrow visible in the trace.
      if (typeof message.method === "string" && message.id !== undefined && message.id !== null) {
        await this.answerCallback(message);
      }
      void frame;
    };

    if (streaming && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Events are separated by a blank line. Keep the tail.
          let split = buffer.indexOf("\n\n");
          while (split !== -1) {
            const event = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            for (const raw of parseSse(event)) await handle(raw);
            split = buffer.indexOf("\n\n");
          }
        }
        if (buffer.trim()) for (const raw of parseSse(buffer)) await handle(raw);
      } finally {
        reader.releaseLock();
      }
    } else {
      const text = await response.text();
      for (const raw of messagesFromBody(text, contentType)) await handle(raw);
    }

    if (!response.ok && parsed.length === 0) {
      throw new GuardError(`The server answered ${response.status} ${response.statusText}.`);
    }

    return parsed;
  }

  private async answerCallback(request: JsonRpcMessage): Promise<void> {
    const result = callbackResult(request.method ?? "");
    if (result === null) return;
    try {
      const { response, timing } = await this.post({ jsonrpc: "2.0", id: request.id, result });
      await this.drain(response, timing);
    } catch {
      this.notes.push(`Could not answer ${request.method}; the server may have timed out.`);
    }
  }

  private async request(method: string, params?: unknown): Promise<JsonRpcMessage> {
    if (this.closed) throw new GuardError("The session is closed.");
    if (Date.now() - this.startedAt > TOTAL_TIMEOUT_MS) throw new GuardError("The inspection took too long and was stopped.");

    const id = this.nextId++;
    this.pending.set(id, { id, method, startedAt: Date.now() });

    const { response, timing } = await this.post({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    const messages = await this.drain(response, timing);
    this.pending.delete(id);

    const answer = messages.find((message) => message.id === id && typeof message.method !== "string");
    if (!answer) throw new GuardError(`${method} returned no response.`);
    if (answer.error) throw new GuardError(`${method} failed: ${answer.error.message}`);
    return answer;
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    const { response, timing } = await this.post({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
    await this.drain(response, timing);
  }

  async initialize(): Promise<void> {
    const answer = await this.request("initialize", {
      protocolVersion: this.protocolVersion,
      capabilities: { roots: { listChanged: true }, sampling: {}, elicitation: {} },
      clientInfo: {
        name: this.options.clientName ?? "mcp-xray",
        version: this.options.clientVersion ?? "0.1.0",
      },
    });

    const result = answer.result as
      | { protocolVersion?: string; serverInfo?: ServerInfo; capabilities?: Record<string, unknown> }
      | undefined;

    if (result?.protocolVersion) this.protocolVersion = result.protocolVersion;
    this.server = result?.serverInfo;
    this.capabilities = result?.capabilities;
    this.clientCapabilities = { roots: { listChanged: true }, sampling: {}, elicitation: {} };

    await this.notify("notifications/initialized");
  }

  async listTools(): Promise<unknown[]> {
    return this.paginate("tools/list", "tools");
  }

  async listResources(): Promise<unknown[]> {
    return this.paginate("resources/list", "resources");
  }

  async listPrompts(): Promise<unknown[]> {
    return this.paginate("prompts/list", "prompts");
  }

  private async paginate(method: string, key: string): Promise<unknown[]> {
    const items: unknown[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 10; page++) {
      const answer = await this.request(method, cursor ? { cursor } : undefined);
      const result = answer.result as Record<string, unknown> | undefined;
      const batch = result?.[key];
      if (Array.isArray(batch)) items.push(...batch);
      const next = result?.nextCursor;
      if (typeof next !== "string" || !next) break;
      cursor = next;
    }

    return items;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const answer = await this.request("tools/call", { name, arguments: args });
    return answer.result;
  }

  async readResource(uri: string): Promise<unknown> {
    const answer = await this.request("resources/read", { uri });
    return answer.result;
  }

  async getPrompt(name: string, args: Record<string, string>): Promise<unknown> {
    const answer = await this.request("prompts/get", { name, arguments: args });
    return answer.result;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await fetch(this.options.endpoint, { method: "DELETE", headers: this.headers() });
    } catch {
      // Closing is best effort; the trace is already complete.
    }
  }

  trace(): Trace {
    return {
      version: 1,
      startedAt: new Date(this.startedAt).toISOString(),
      target: this.options.endpoint,
      transport: this.transport,
      server: this.server,
      capabilities: this.capabilities,
      clientCapabilities: this.clientCapabilities,
      frames: linkLatency(this.frames),
      notes: this.notes.length > 0 ? this.notes : undefined,
    };
  }
}

/**
 * The client side of the three server-to-client requests. A real client would
 * show a dialog; the inspector answers with a fixed, honest payload so the
 * trace shows the round trip without pretending to be a model.
 */
function callbackResult(method: string): unknown | null {
  switch (method) {
    case "roots/list":
      return { roots: [{ uri: "file:///home/user/project", name: "project" }] };
    case "sampling/createMessage":
      return {
        role: "assistant",
        content: { type: "text", text: "[mcp-xray] Sampling is not run by the inspector." },
        model: "mcp-xray",
        stopReason: "endTurn",
      };
    case "elicitation/create":
      return { action: "decline" };
    default:
      return null;
  }
}
