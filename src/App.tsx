import { useMemo, useState } from "react";
import { Footer, Header } from "@adityavhlvy/design-system";
import type { RenderLink } from "@adityavhlvy/design-system";
import type { Trace } from "../shared/types";
import { callTree } from "./lib/trace";
import { TEXTBOOK } from "./lib/textbook";
import { CallTree } from "./ui/CallTree";
import { Inspector } from "./ui/Inspector";
import { Overview } from "./ui/Overview";
import { Sequence } from "./ui/Sequence";
import { buttonClass, fieldClass, panelClass } from "./ui/controls";
import { channels as siteChannels, profile as siteProfile } from "./site";

const SITE_ORIGIN = (import.meta.env.PUBLIC_BASE_URL ?? "https://adityavhlvy.vercel.app").replace(/\/+$/, "");
const BASE_PATH = (import.meta.env.PUBLIC_BASE_PATH ?? "").replace(/\/+$/, "");

const renderLink: RenderLink = ({ to, className, children, onClick, ...rest }) => (
  <a href={`${SITE_ORIGIN}${to}`} className={className} onClick={onClick} {...rest}>
    {children}
  </a>
);

const openSearch = () => window.location.assign(`${SITE_ORIGIN}/?palette=open`);

type Status = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string };

export default function App() {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [toolName, setToolName] = useState("");
  const [toolArgs, setToolArgs] = useState("{}");
  const [trace, setTrace] = useState<Trace | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [selected, setSelected] = useState<number | null>(null);
  const [cursor, setCursor] = useState(0);
  const [activeTextbook, setActiveTextbook] = useState<string | null>(null);

  const tree = useMemo(() => (trace ? callTree(trace) : []), [trace]);
  const frame = trace && selected !== null ? (trace.frames[selected] ?? null) : null;

  const load = (next: Trace, textbookId: string | null) => {
    setTrace(next);
    setSelected(null);
    setCursor(next.frames.length - 1);
    setActiveTextbook(textbookId);
    setStatus({ kind: "idle" });
  };

  const inspect = async () => {
    if (!url.trim()) return;
    setStatus({ kind: "loading" });
    setTrace(null);

    let args: Record<string, unknown> = {};
    if (toolName.trim()) {
      try {
        const parsed: unknown = JSON.parse(toolArgs || "{}");
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
        args = parsed as Record<string, unknown>;
      } catch {
        setStatus({ kind: "error", message: "Tool arguments must be a JSON object." });
        return;
      }
    }

    try {
      const response = await fetch(`${BASE_PATH}/api/inspect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, token: token || undefined, callTool: toolName || undefined, toolArgs: args }),
      });
      const payload = (await response.json()) as { trace?: Trace; error?: string | null };

      if (!payload.trace) {
        setStatus({ kind: "error", message: payload.error ?? "The server did not answer." });
        return;
      }
      load(payload.trace, null);
      if (payload.error) setStatus({ kind: "error", message: payload.error });
    } catch {
      setStatus({ kind: "error", message: "Could not reach the inspector. Check your connection." });
    }
  };

  const exportHtml = () => {
    if (!trace) return;
    const html = standalone(trace);
    const blob = new Blob([html], { type: "text/html" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `mcp-trace-${trace.server?.name ?? "server"}.html`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const copyJson = async () => {
    if (!trace) return;
    await navigator.clipboard.writeText(JSON.stringify(trace, null, 2));
  };

  return (
    <>
      <Header activePath="/tools/mcp-xray" onSearch={openSearch} renderLink={renderLink} />

      <main className="mx-auto max-w-[1440px] px-5 pt-16 pb-24 md:px-10">
        <section className="pt-12 pb-10 md:pt-16">
          <p className="label">Tool</p>
          <h1 className="display mt-4 max-w-[18ch] text-[clamp(2.6rem,6vw,5rem)]">See the protocol, not the log.</h1>
          <p className="mt-5 max-w-[62ch] text-lg text-mute">
            Point it at a public MCP endpoint and get a trace you can play back: every frame, both directions, and the
            server-to-client callbacks most clients never show you.
          </p>
        </section>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start lg:gap-10">
          <div className="grid gap-4">
            <section className={`${panelClass} p-5 md:p-6`}>
              <h2 className="label">Endpoint</h2>
              <div className="mt-4 grid gap-3">
                <label className="grid gap-2">
                  <span className="text-sm text-mute">MCP URL</span>
                  <input
                    className={fieldClass}
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    placeholder="https://example.com/mcp"
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>

                <label className="grid gap-2">
                  <span className="text-sm text-mute">Bearer token (optional, never stored)</span>
                  <input
                    className={fieldClass}
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    placeholder="paste a token"
                    type="password"
                    autoComplete="off"
                  />
                </label>

                <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
                  <label className="grid gap-2">
                    <span className="text-sm text-mute">Call a tool (optional)</span>
                    <input
                      className={fieldClass}
                      value={toolName}
                      onChange={(event) => setToolName(event.target.value)}
                      placeholder="echo"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <label className="grid gap-2">
                    <span className="text-sm text-mute">Arguments (JSON)</span>
                    <input
                      className={fieldClass}
                      value={toolArgs}
                      onChange={(event) => setToolArgs(event.target.value)}
                      placeholder='{"text":"hello"}'
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className={buttonClass("primary")} onClick={inspect} disabled={status.kind === "loading" || !url.trim()}>
                    {status.kind === "loading" ? "Inspecting..." : "Inspect"}
                  </button>
                  <button type="button" className={buttonClass("outline")} onClick={() => setUrl(`${window.location.origin}${BASE_PATH}/api/mock`)}>
                    Use the mock server
                  </button>
                </div>

                {status.kind === "error" ? (
                  <p role="alert" className="border-l-2 border-sea pl-3 text-sm">
                    {status.message}
                  </p>
                ) : null}
              </div>
            </section>

            {trace ? (
              <>
                <Sequence trace={trace} selected={selected} onSelect={setSelected} />
                <Inspector frame={frame} />
              </>
            ) : (
              <section className={`${panelClass} grid min-h-[320px] place-items-center p-8 text-center`}>
                <div className="max-w-[40ch]">
                  <p className="text-sm text-mute">
                    Nothing inspected yet. Paste an endpoint, or open one of the recorded traces on the right.
                  </p>
                </div>
              </section>
            )}
          </div>

          <aside className="grid gap-4 lg:sticky lg:top-24">
            {trace ? (
              <>
                <Overview trace={trace} cursor={cursor} />
                <CallTree nodes={tree} selected={selected} onSelect={setSelected} />
                <section className={`${panelClass} p-4`}>
                  <h2 className="label mb-3">Export</h2>
                  <div className="grid gap-2">
                    <button type="button" className={buttonClass("outline")} onClick={exportHtml}>
                      Download HTML
                    </button>
                    <button type="button" className={buttonClass("ghost")} onClick={copyJson}>
                      Copy trace JSON
                    </button>
                  </div>
                  <p className="mt-3 text-xs text-mute">
                    Tokens and secrets are redacted before the trace leaves the server.
                  </p>
                </section>
              </>
            ) : null}

            <section className={`${panelClass} p-4`} aria-label="Trace textbook">
              <h2 className="label mb-1">Trace textbook</h2>
              <p className="mb-3 text-xs text-mute">Recorded traces. No network, no server.</p>
              <ul className="grid gap-1">
                {TEXTBOOK.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className={`w-full border p-3 text-left transition-colors ${
                        activeTextbook === entry.id ? "border-ink bg-sunk" : "border-line hover:border-ink"
                      }`}
                      onClick={() => load(entry.trace, entry.id)}
                    >
                      <span className="block text-sm font-medium">{entry.title}</span>
                      <span className="mt-1 block text-xs text-mute">{entry.summary}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            {activeTextbook ? (
              <section className={`${panelClass} p-4`} aria-label="What this trace teaches">
                <h2 className="label mb-2">What to notice</h2>
                <p className="text-sm text-mute">{TEXTBOOK.find((entry) => entry.id === activeTextbook)?.teaches}</p>
              </section>
            ) : null}
          </aside>
        </div>

        <section className="mt-16 grid gap-4 border-t border-line pt-10 md:grid-cols-2 md:gap-10">
          <div>
            <h2 className="label">What it does not do</h2>
            <p className="mt-3 max-w-[58ch] text-mute">
              It does not run stdio servers, and it does not complete OAuth. Paste a bearer token for servers that need
              one. Everything else is a plain HTTP request you could make with curl.
            </p>
          </div>
          <div>
            <h2 className="label">Why the arrows matter</h2>
            <p className="mt-3 max-w-[58ch] text-mute">
              MCP is bidirectional. A server can ask the client to sample a model, list roots, or ask the user a
              question. Those frames travel the other way, and they are the ones worth seeing.
            </p>
          </div>
        </section>
      </main>

      <Footer profile={siteProfile} channels={siteChannels} renderLink={renderLink} />
    </>
  );
}

/**
 * A single file with the trace inlined. It is deliberately plain: the point is
 * that a trace can be attached to an issue and opened years later.
 */
function standalone(trace: Trace): string {
  const rows = trace.frames
    .map(
      (item) =>
        `<tr><td>${item.i}</td><td>${item.t} ms</td><td>${item.dir === "out" ? "client → server" : "server → client"}</td><td>${item.method ?? item.kind}</td><td><pre>${escapeHtml(JSON.stringify(item.msg, null, 2))}</pre></td></tr>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>MCP trace: ${escapeHtml(trace.server?.name ?? trace.target)}</title>
<style>
body{font:14px/1.5 ui-sans-serif,system-ui,sans-serif;margin:2rem;color:#121518;background:#eceee9}
h1{font-size:1.4rem;margin:0 0 .25rem}p{color:#4a5058;margin:0 0 1.5rem}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #c6cbc3;padding:.5rem;text-align:left;vertical-align:top}
th{background:#e1e4de;font-size:.75rem;text-transform:uppercase;letter-spacing:.08em}
pre{margin:0;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;word-break:break-word}
</style></head><body>
<h1>${escapeHtml(trace.server?.name ?? "MCP trace")}</h1>
<p>${escapeHtml(trace.target)} · ${trace.frames.length} frames · ${escapeHtml(trace.startedAt)}</p>
<table><thead><tr><th>#</th><th>t</th><th>direction</th><th>method</th><th>message</th></tr></thead>
<tbody>${rows}</tbody></table>
</body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
