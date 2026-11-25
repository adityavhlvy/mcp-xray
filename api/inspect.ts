import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Session } from "../server/mcp.js";
import { GuardError } from "../server/guard.js";
import { redactFrame } from "../shared/frame.js";
import type { Trace } from "../shared/types.js";

/**
 * Inspects a public MCP endpoint: handshake, then the three list methods, and
 * one optional tool call. The response is a complete trace, already redacted.
 */

const MAX_BODY = 8_192;

interface InspectBody {
  url?: unknown;
  token?: unknown;
  headers?: unknown;
  callTool?: unknown;
  toolArgs?: unknown;
  readResourceUri?: unknown;
}

function readHeaders(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== "string") continue;
    // Only header-safe characters, and never a newline.
    if (!/^[\w-]+$/.test(key) || item.length > 1024 || /[\r\n]/.test(item)) continue;
    out[key.toLowerCase()] = item;
  }
  return out;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const raw = JSON.stringify(req.body ?? "");
  if (raw.length > MAX_BODY) return res.status(413).json({ error: "That request is too large." });

  const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as InspectBody;
  const endpoint = typeof body.url === "string" ? body.url.trim() : "";
  if (!endpoint) return res.status(400).json({ error: "Paste an MCP endpoint URL." });

  const headers = readHeaders(body.headers);
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (token) {
    if (token.length > 4096 || /[\r\n]/.test(token)) return res.status(400).json({ error: "That token is not valid." });
    headers.authorization = `Bearer ${token}`;
  }

  const session = new Session({
    endpoint,
    headers,
    // The mock server lives on loopback, so local development needs the seam.
    // On Vercel `VERCEL` is always set, which keeps the guard strict in prod.
    allowPrivate: process.env.MCP_XRAY_ALLOW_LOOPBACK === "1" || !process.env.VERCEL,
  });
  const notes: string[] = [];
  let failed: string | null = null;

  try {
    await session.initialize();

    await session.listTools().catch((error: unknown) => {
      notes.push(`tools/list: ${message(error)}`);
      return [];
    });
    await session.listResources().catch((error: unknown) => {
      notes.push(`resources/list: ${message(error)}`);
      return [];
    });
    await session.listPrompts().catch((error: unknown) => {
      notes.push(`prompts/list: ${message(error)}`);
      return [];
    });

    if (typeof body.callTool === "string" && body.callTool.trim()) {
      const args =
        typeof body.toolArgs === "object" && body.toolArgs !== null ? (body.toolArgs as Record<string, unknown>) : {};
      await session.callTool(body.callTool.trim(), args).catch((error: unknown) => {
        notes.push(`tools/call: ${message(error)}`);
        return null;
      });
    }

    if (typeof body.readResourceUri === "string" && body.readResourceUri.trim()) {
      await session.readResource(body.readResourceUri.trim()).catch((error: unknown) => {
        notes.push(`resources/read: ${message(error)}`);
        return null;
      });
    }
  } catch (error) {
    failed = message(error);
    if (!(error instanceof GuardError)) console.error("POST /api/inspect", error);
  } finally {
    await session.close();
  }

  const trace = session.trace();
  if (notes.length > 0) trace.notes = [...(trace.notes ?? []), ...notes];

  // A failed handshake still returns a trace. The frames are the explanation.
  if (trace.frames.length === 0) {
    return res.status(failed ? 502 : 500).json({ error: failed ?? "The server did not respond.", trace: null });
  }

  return res.status(200).json({ trace: sanitize(trace), error: failed });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

/** Redaction happens on the server so a raw token never reaches the browser. */
export function sanitize(trace: Trace): Trace {
  return { ...trace, frames: trace.frames.map(redactFrame) };
}
