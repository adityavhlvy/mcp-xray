import { LIFECYCLE } from "../../shared/types";
import type { Trace } from "../../shared/types";
import { byMethod, formatBytes, formatMs, label, lifecycleAt, spans, stats, surface } from "../lib/trace";
import { panelClass, rowClass } from "./controls";

interface Props {
  trace: Trace;
  cursor: number;
}

const SURFACE_LABEL: Record<string, string> = {
  tools: "Tools",
  resources: "Resources",
  prompts: "Prompts",
  logging: "Logging",
  sampling: "Sampling",
  roots: "Roots",
  elicitation: "Elicitation",
  completions: "Completions",
};

export function Overview({ trace, cursor }: Props) {
  const numbers = stats(trace);
  const caps = surface(trace);
  const state = lifecycleAt(trace, cursor);
  const methods = byMethod(trace);
  const timeline = spans(trace);
  const span = Math.max(1, numbers.durationMs);

  return (
    <div className="grid gap-4">
      <section className={`${panelClass} p-4`} aria-label="Summary">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="label">Summary</h2>
          <span className="font-mono text-xs">
            {trace.server?.name ?? "unknown server"}
            {trace.server?.version ? ` ${trace.server.version}` : ""}
          </span>
        </div>

        <dl className="mt-3 grid grid-cols-2 gap-y-2 font-mono text-xs sm:grid-cols-4">
          {[
            ["frames", String(numbers.frames)],
            ["req / res", `${numbers.requests} / ${numbers.responses}`],
            ["callbacks", String(numbers.callbacks)],
            ["errors", String(numbers.errors)],
            ["bytes", formatBytes(numbers.bytes)],
            ["span", formatMs(numbers.durationMs)],
            ["transport", trace.transport],
            ["slowest", numbers.slowest?.latencyMs !== undefined ? formatMs(numbers.slowest.latencyMs) : "—"],
          ].map(([key, value]) => (
            <div key={key}>
              <dt className="text-mute">{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-4 border-t border-line pt-3">
          <p className="label mb-2">Lifecycle</p>
          <ol className="flex flex-wrap gap-1">
            {LIFECYCLE.map((step) => {
              const at = LIFECYCLE.indexOf(step) <= LIFECYCLE.indexOf(state);
              return (
                <li
                  key={step}
                  className={`border px-2 py-1 font-mono text-[10px] ${
                    step === state ? "border-sea bg-sea text-on-sea" : at ? "border-ink text-ink" : "border-line text-mute"
                  }`}
                >
                  {step}
                </li>
              );
            })}
          </ol>
        </div>

        <div className="mt-4 border-t border-line pt-3">
          <p className="label mb-2">What the server can do</p>
          <ul className="flex flex-wrap gap-1">
            {Object.entries(caps).map(([key, on]) => (
              <li
                key={key}
                className={`border px-2 py-1 font-mono text-[10px] ${on ? "border-ink text-ink" : "border-line text-mute line-through"}`}
              >
                {SURFACE_LABEL[key] ?? key}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className={`${panelClass} p-4`} aria-label="Waterfall">
        <h2 className="label mb-3">Waterfall</h2>
        {timeline.length === 0 ? (
          <p className="text-sm text-mute">No completed calls.</p>
        ) : (
          <ul className="grid gap-2">
            {timeline.map((item) => {
              const left = (item.start / span) * 100;
              const width = Math.max(0.8, ((item.end - item.start) / span) * 100);
              return (
                <li key={item.frame.i} className="grid grid-cols-[minmax(90px,150px)_1fr_auto] items-center gap-2">
                  <span className="truncate font-mono text-[10px] text-mute">{item.frame.method ?? label(item.frame)}</span>
                  <span className="relative block h-3 bg-sunk">
                    <span className="absolute inset-y-0 bg-sea" style={{ left: `${left}%`, width: `${width}%` }} />
                  </span>
                  <span className="font-mono text-[10px] text-mute">{formatMs(item.end - item.start)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className={`${panelClass} p-4`} aria-label="Time by method">
        <h2 className="label mb-2">Time by method</h2>
        {methods.length === 0 ? (
          <p className="text-sm text-mute">Nothing measured.</p>
        ) : (
          <ul className="divide-y divide-line">
            {methods.map((item) => (
              <li key={item.method} className={rowClass}>
                <span className="font-mono text-xs">{item.method}</span>
                <span className="font-mono text-[10px] text-mute">
                  {item.count}× · {formatMs(item.totalMs)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {trace.notes && trace.notes.length > 0 ? (
        <section className={`${panelClass} p-4`} aria-label="Notes">
          <h2 className="label mb-2">Notes</h2>
          <ul className="grid gap-1 text-sm text-mute">
            {trace.notes.map((note, index) => (
              <li key={index} className="border-l-2 border-sea pl-2">
                {note}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
