import type { Direction, Frame, FrameKind, Sender } from "./types.js";

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A message is a request when it has a method and an id, a notification when
 * it has a method and no id, and a response when it has neither. An error
 * response is still a response; the kind only changes the colour.
 */
export function classify(message: JsonRpcMessage): FrameKind {
  if (typeof message.method === "string") {
    return message.id === undefined || message.id === null ? "notification" : "request";
  }
  if (message.error !== undefined) return "error";
  return "response";
}

export function senderOf(dir: Direction): Sender {
  return dir === "out" ? "client" : "server";
}

/** Parses one wire payload. Returns null when the bytes are not JSON. */
export function parseMessage(raw: string): JsonRpcMessage | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? (parsed as JsonRpcMessage) : null;
  } catch {
    return null;
  }
}

export interface FrameInput {
  i: number;
  t: number;
  dir: Direction;
  raw: string;
}

export function makeFrame({ i, t, dir, raw }: FrameInput): Frame {
  const msg = parseMessage(raw);
  const kind: FrameKind = msg ? classify(msg) : "notification";
  return {
    i,
    t,
    dir,
    kind,
    id: msg?.id ?? undefined,
    method: msg?.method,
    raw,
    msg,
    bytes: new TextEncoder().encode(raw).length,
  };
}

/**
 * Pairs each response with the request that shares its id, and writes the
 * round-trip time back onto the response frame. Requests and responses share
 * an id space per direction, so the direction is part of the key.
 */
export function linkLatency(frames: Frame[]): Frame[] {
  const open = new Map<string, Frame>();
  const key = (frame: Frame) => `${frame.dir}:${String(frame.id)}`;

  for (const frame of frames) {
    if (frame.kind === "request" && frame.id !== undefined) {
      open.set(key(frame), frame);
      continue;
    }
    if (frame.kind !== "response" && frame.kind !== "error") continue;
    if (frame.id === undefined) continue;

    // A response travels the opposite way from its request.
    const request = open.get(`${frame.dir === "in" ? "out" : "in"}:${String(frame.id)}`);
    if (!request) continue;
    frame.latencyMs = Math.max(0, frame.t - request.t);
    open.delete(`${frame.dir === "in" ? "out" : "in"}:${String(frame.id)}`);
  }

  return frames;
}

const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|cookie|credential|session)/i;

/**
 * Traces get pasted into issues. Anything that looks like a credential is
 * replaced before the trace is shown or exported, and the replacement is
 * visible so nobody thinks the value was empty.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[deep]";
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (!isObject(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key) && typeof item === "string" && item.length > 0) {
      out[key] = `[redacted ${item.length} chars]`;
      continue;
    }
    out[key] = redact(item, depth + 1);
  }
  return out;
}

/** Redacts the parsed message and the raw bytes together, so both views agree. */
export function redactFrame(frame: Frame): Frame {
  if (!frame.msg) return frame;
  const msg = redact(frame.msg);
  return { ...frame, msg, raw: JSON.stringify(msg) };
}

/**
 * Streamable HTTP replies with `text/event-stream`. Each `data:` line is one
 * JSON-RPC message. A blank line ends an event, and a comment line starts
 * with a colon. Splitting on newlines alone breaks on multi-line data.
 */
export function parseSse(body: string): string[] {
  const messages: string[] = [];
  let buffer: string[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    messages.push(buffer.join("\n"));
    buffer = [];
  };

  for (const line of body.split(/\r?\n/)) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== "data") continue;
    const value = colon === -1 ? "" : line.slice(colon + 1);
    buffer.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  flush();

  return messages.filter((message) => message.trim() !== "");
}

/** True when the response body is an event stream rather than one JSON value. */
export function isEventStream(contentType: string | null): boolean {
  return (contentType ?? "").toLowerCase().includes("text/event-stream");
}

/** Extracts every JSON-RPC message from a response body, SSE or plain. */
export function messagesFromBody(body: string, contentType: string | null): string[] {
  if (isEventStream(contentType)) return parseSse(body);
  const trimmed = body.trim();
  if (!trimmed) return [];
  // Some servers answer a batch with a JSON array.
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((item) => JSON.stringify(item));
    } catch {
      // Fall through to the single-message path.
    }
  }
  return [trimmed];
}
