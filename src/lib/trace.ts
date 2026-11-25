import type { Frame, Lifecycle, Trace } from "../../shared/types.js";

export interface Stats {
  frames: number;
  requests: number;
  responses: number;
  notifications: number;
  errors: number;
  callbacks: number;
  bytes: number;
  durationMs: number;
  slowest: Frame | null;
}

export function stats(trace: Trace): Stats {
  const frames = trace.frames;
  const responses = frames.filter((frame) => frame.kind === "response" || frame.kind === "error");
  const slowest = responses.reduce<Frame | null>(
    (best, frame) => (frame.latencyMs !== undefined && (best === null || frame.latencyMs > (best.latencyMs ?? 0)) ? frame : best),
    null,
  );

  return {
    frames: frames.length,
    requests: frames.filter((frame) => frame.kind === "request").length,
    responses: responses.length,
    notifications: frames.filter((frame) => frame.kind === "notification").length,
    errors: frames.filter((frame) => frame.kind === "error").length,
    callbacks: frames.filter((frame) => frame.kind === "request" && frame.dir === "in").length,
    bytes: frames.reduce((total, frame) => total + frame.bytes, 0),
    durationMs: frames.length > 0 ? frames[frames.length - 1].t : 0,
    slowest,
  };
}

/**
 * The lifecycle state at a given frame. The spec has five states, and the
 * transition that matters is `initialize` request to `initialized`
 * notification. Everything else is a detail.
 */
export function lifecycleAt(trace: Trace, index: number): Lifecycle {
  let state: Lifecycle = "uninitialized";

  for (const frame of trace.frames) {
    if (frame.i > index) break;
    if (frame.method === "initialize" && frame.kind === "request") state = "initializing";
    if (frame.method === "notifications/initialized") state = "initialized";
    if (frame.method === "shutdown") state = "closing";
  }

  return state;
}

export interface Surface {
  tools: boolean;
  resources: boolean;
  prompts: boolean;
  logging: boolean;
  sampling: boolean;
  roots: boolean;
  elicitation: boolean;
  completions: boolean;
}

/**
 * Which primitives the server actually implements, read from the capabilities
 * it announced. This is the "how much of the protocol does this thing really
 * do" number, and it is the honest answer to "is this server complete".
 */
export function surface(trace: Trace): Surface {
  const caps = (trace.capabilities ?? {}) as Record<string, unknown>;
  const has = (key: string) => caps[key] !== undefined && caps[key] !== null;
  return {
    tools: has("tools"),
    resources: has("resources"),
    prompts: has("prompts"),
    logging: has("logging"),
    sampling: has("sampling"),
    roots: has("roots"),
    elicitation: has("elicitation"),
    completions: has("completions"),
  };
}

export interface TreeNode {
  frame: Frame;
  children: TreeNode[];
  /** True when the parent link is a guess from timing. */
  inferred: boolean;
}

/**
 * Builds the call tree. A server-to-client request that arrives while a
 * client request is still open is almost certainly caused by it, but the
 * protocol has no field that says so. The link is marked inferred.
 */
export function callTree(trace: Trace): TreeNode[] {
  const roots: TreeNode[] = [];
  const open: Array<{ node: TreeNode; until: number }> = [];

  for (const frame of trace.frames) {
    if (frame.kind === "notification") continue;

    if (frame.kind === "request" && frame.dir === "out") {
      const node: TreeNode = { frame, children: [], inferred: false };
      roots.push(node);
      open.push({ node, until: Number.POSITIVE_INFINITY });
      continue;
    }

    if (frame.kind === "response" || frame.kind === "error") {
      // Close the request this answers.
      const match = open.find((entry) => entry.node.frame.id === frame.id && entry.node.frame.dir === "out");
      if (match) match.until = frame.t;
      continue;
    }

    if (frame.kind === "request" && frame.dir === "in") {
      const parent = open
        .filter((entry) => entry.until >= frame.t)
        .sort((a, b) => b.node.frame.t - a.node.frame.t)[0];
      const node: TreeNode = { frame, children: [], inferred: true };
      if (parent) parent.node.children.push(node);
      else roots.push(node);
    }
  }

  return roots;
}

export interface Span {
  frame: Frame;
  start: number;
  end: number;
  depth: number;
}

/** Pairs requests with responses so the waterfall can draw a bar per call. */
export function spans(trace: Trace): Span[] {
  const out: Span[] = [];
  const open = new Map<string, Frame>();
  const key = (frame: Frame) => `${frame.dir}:${String(frame.id)}`;

  for (const frame of trace.frames) {
    if (frame.kind === "request" && frame.id !== undefined) {
      open.set(key(frame), frame);
      continue;
    }
    if (frame.kind !== "response" && frame.kind !== "error") continue;
    if (frame.id === undefined) continue;

    const request = open.get(`${frame.dir === "in" ? "out" : "in"}:${String(frame.id)}`);
    if (!request) continue;
    open.delete(`${frame.dir === "in" ? "out" : "in"}:${String(frame.id)}`);
    out.push({ frame: request, start: request.t, end: frame.t, depth: 0 });
  }

  return out;
}

/** Groups frames by method so the summary can show where the time went. */
export function byMethod(trace: Trace): Array<{ method: string; count: number; totalMs: number }> {
  const map = new Map<string, { count: number; totalMs: number }>();

  for (const frame of trace.frames) {
    if (frame.kind !== "response" && frame.kind !== "error") continue;
    const request = trace.frames.find(
      (candidate) =>
        candidate.kind === "request" &&
        candidate.id === frame.id &&
        candidate.dir !== frame.dir,
    );
    const method = request?.method ?? "(unknown)";
    const entry = map.get(method) ?? { count: 0, totalMs: 0 };
    entry.count++;
    entry.totalMs += frame.latencyMs ?? 0;
    map.set(method, entry);
  }

  return [...map.entries()]
    .map(([method, value]) => ({ method, ...value }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function formatMs(ms: number): string {
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Pretty-prints a JSON-RPC message for the inspector. */
export function pretty(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** A short, human label for a frame, used in the diagram and the tree. */
export function label(frame: Frame): string {
  if (frame.method) return frame.method;
  if (frame.kind === "error") return "error";
  return "response";
}

/** Hex dump for the deepest peel level. */
export function hexDump(text: string, width = 16): string[] {
  const bytes = new TextEncoder().encode(text);
  const lines: string[] = [];

  for (let offset = 0; offset < bytes.length; offset += width) {
    const slice = bytes.slice(offset, offset + width);
    const hex = [...slice].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...slice].map((byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".")).join("");
    lines.push(`${offset.toString(16).padStart(6, "0")}  ${hex.padEnd(width * 3 - 1)}  ${ascii}`);
  }

  return lines;
}
