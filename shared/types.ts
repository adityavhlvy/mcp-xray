/**
 * A trace is a list of frames. A frame is one JSON-RPC message as it crossed
 * the wire, plus the timing and the raw bytes. Nothing here is derived: the
 * viewer computes everything else, so a trace stays portable and diffable.
 */

export type Direction = "out" | "in";

export type FrameKind = "request" | "response" | "notification" | "error";

/** Who sent the message. A server can send requests too, which is the point. */
export type Sender = "client" | "server";

export interface Frame {
  /** Position in the trace, 0-based. */
  i: number;
  /** Milliseconds since the trace started. */
  t: number;
  dir: Direction;
  kind: FrameKind;
  /** JSON-RPC id, when the message has one. */
  id?: number | string;
  method?: string;
  /** The exact bytes on the wire, before parsing. */
  raw: string;
  /** Parsed JSON-RPC message, or null when the bytes were not JSON. */
  msg: unknown;
  /** Set on a response: time from the matching request, in ms. */
  latencyMs?: number;
  bytes: number;
  /** Index of the frame that most likely caused this one. */
  parent?: number;
  /** True when `parent` is a guess from timing, not a protocol field. */
  inferred?: boolean;
  /** Transport detail for the waterfall: dns, tcp, tls, ttfb, download. */
  timing?: TransportTiming;
}

export interface TransportTiming {
  dns?: number;
  tcp?: number;
  tls?: number;
  ttfb?: number;
  download?: number;
}

export type Transport = "http" | "sse" | "mock";

export interface Trace {
  version: 1;
  /** ISO timestamp of the first frame. */
  startedAt: string;
  /** The endpoint that was inspected. */
  target: string;
  transport: Transport;
  /** Server identity from `initialize`, when the handshake succeeded. */
  server?: ServerInfo;
  /** Capabilities the server announced. */
  capabilities?: Record<string, unknown>;
  /** Capabilities the client announced. */
  clientCapabilities?: Record<string, unknown>;
  frames: Frame[];
  /** Non-fatal problems, for example a request that timed out. */
  notes?: string[];
}

export interface ServerInfo {
  name?: string;
  version?: string;
  title?: string;
  websiteUrl?: string;
}

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export type ProtocolVersion = (typeof PROTOCOL_VERSIONS)[number];

/** Lifecycle states from the MCP spec, in order. */
export const LIFECYCLE = ["uninitialized", "initializing", "initialized", "closing", "closed"] as const;
export type Lifecycle = (typeof LIFECYCLE)[number];

/** The three client-side primitives a server may call back into. */
export const CALLBACKS = ["sampling/createMessage", "roots/list", "elicitation/create"] as const;
export type Callback = (typeof CALLBACKS)[number];

export const MAX_FRAME_BYTES = 1_000_000;
export const MAX_FRAMES = 2_000;
export const REQUEST_TIMEOUT_MS = 10_000;
export const TOTAL_TIMEOUT_MS = 30_000;
