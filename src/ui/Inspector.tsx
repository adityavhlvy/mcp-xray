import { useState } from "react";
import type { Frame } from "../../shared/types";
import { hexDump, pretty } from "../lib/trace";
import { chipClass, panelClass } from "./controls";

interface Props {
  frame: Frame | null;
}

const LEVELS = ["bytes", "json", "protocol", "payload"] as const;
type Level = (typeof LEVELS)[number];

const HINT: Record<Level, string> = {
  bytes: "The exact bytes on the wire. Nothing is normalised.",
  json: "The same bytes, parsed and indented.",
  protocol: "What the message means in MCP: method, id, and whether it is legal here.",
  payload: "The result or params, rendered as the client would show it.",
};

function contentBlocks(value: unknown): Array<{ type: string; text?: string; data?: string; mimeType?: string }> {
  if (typeof value !== "object" || value === null) return [];
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content.filter(
    (item): item is { type: string; text?: string; data?: string; mimeType?: string } =>
      typeof item === "object" && item !== null && typeof (item as { type?: unknown }).type === "string",
  );
}

export function Inspector({ frame }: Props) {
  const [level, setLevel] = useState<Level>("json");

  if (!frame) {
    return (
      <section className={`${panelClass} grid min-h-[280px] place-items-center p-6 text-center`} aria-label="Frame inspector">
        <p className="max-w-[32ch] text-sm text-mute">Pick a frame in the diagram or the tree to peel it apart.</p>
      </section>
    );
  }

  const blocks = contentBlocks(frame.msg);

  return (
    <section className={`${panelClass}`} aria-label="Frame inspector">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex items-baseline gap-2">
          <h2 className="label">Frame {frame.i}</h2>
          <span className="font-mono text-xs text-mute">
            {frame.dir === "out" ? "client → server" : "server → client"} · {frame.kind}
          </span>
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Peel level">
          {LEVELS.map((item) => (
            <button key={item} type="button" aria-pressed={item === level} className={chipClass(item === level)} onClick={() => setLevel(item)}>
              {item}
            </button>
          ))}
        </div>
      </div>

      <p className="border-b border-line px-4 py-2 text-xs text-mute">{HINT[level]}</p>

      <div className="max-h-[420px] overflow-auto p-4">
        {level === "bytes" ? (
          <pre className="font-mono text-[11px] leading-5 text-ink">{hexDump(frame.raw).join("\n")}</pre>
        ) : null}

        {level === "json" ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-ink">{pretty(frame.msg)}</pre>
        ) : null}

        {level === "protocol" ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 font-mono text-xs">
            <dt className="text-mute">jsonrpc</dt>
            <dd>{(frame.msg as { jsonrpc?: string } | null)?.jsonrpc ?? "—"}</dd>
            <dt className="text-mute">id</dt>
            <dd>{frame.id ?? "— (notification)"}</dd>
            <dt className="text-mute">method</dt>
            <dd>{frame.method ?? "— (response)"}</dd>
            <dt className="text-mute">kind</dt>
            <dd>{frame.kind}</dd>
            <dt className="text-mute">bytes</dt>
            <dd>{frame.bytes}</dd>
            <dt className="text-mute">at</dt>
            <dd>{frame.t} ms</dd>
            {frame.latencyMs !== undefined ? (
              <>
                <dt className="text-mute">round trip</dt>
                <dd>{frame.latencyMs} ms</dd>
              </>
            ) : null}
            {frame.inferred ? (
              <>
                <dt className="text-mute">parent</dt>
                <dd className="text-sea">frame {frame.parent} (inferred from timing)</dd>
              </>
            ) : null}
          </dl>
        ) : null}

        {level === "payload" ? (
          blocks.length > 0 ? (
            <ul className="grid gap-3">
              {blocks.map((block, index) => (
                <li key={index} className="border border-line p-3">
                  <p className="label mb-2">{block.type}</p>
                  {block.type === "text" ? (
                    <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5">{block.text}</pre>
                  ) : block.type === "image" && block.data ? (
                    <img
                      src={`data:${block.mimeType ?? "image/png"};base64,${block.data}`}
                      alt="Content block"
                      className="max-h-48 w-auto"
                    />
                  ) : (
                    <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5">{pretty(block)}</pre>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-mute">
              {pretty((frame.msg as { result?: unknown; params?: unknown } | null)?.result ?? (frame.msg as { params?: unknown } | null)?.params)}
            </pre>
          )
        ) : null}
      </div>
    </section>
  );
}
