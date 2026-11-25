import { useEffect, useMemo, useRef, useState } from "react";
import type { Trace } from "../../shared/types";
import { formatMs, label } from "../lib/trace";
import { buttonClass, chipClass, panelClass } from "./controls";

interface Props {
  trace: Trace;
  selected: number | null;
  onSelect: (index: number | null) => void;
}

const ROW = 34;
const TOP = 56;
const LEFT = 96;
const RIGHT = 96;

/**
 * Two lifelines, time flowing down. A request is a solid arrow, a response is
 * dashed, and a server-to-client request is drawn in the accent colour with a
 * badge, because that is the frame people do not expect.
 */
export function Sequence({ trace, selected, onSelect }: Props) {
  const [playing, setPlaying] = useState(false);
  const [cursor, setCursor] = useState(trace.frames.length - 1);
  const scroller = useRef<HTMLDivElement>(null);

  const frames = trace.frames;
  const height = TOP + frames.length * ROW + 24;

  useEffect(() => {
    setCursor(frames.length - 1);
    setPlaying(false);
  }, [trace, frames.length]);

  useEffect(() => {
    if (!playing) return;
    if (cursor >= frames.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setCursor((value) => value + 1), 420);
    return () => clearTimeout(timer);
  }, [playing, cursor, frames.length]);

  useEffect(() => {
    const node = scroller.current?.querySelector<HTMLElement>(`[data-row="${cursor}"]`);
    node?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [cursor]);

  const rows = useMemo(
    () =>
      frames.map((frame, index) => {
        const y = TOP + index * ROW;
        const isCallback = frame.kind === "request" && frame.dir === "in";
        const isResponse = frame.kind === "response" || frame.kind === "error";
        const active = index === cursor;
        const chosen = index === selected;
        return { frame, index, y, isCallback, isResponse, active, chosen };
      }),
    [frames, cursor, selected],
  );

  return (
    <section className={`${panelClass} overflow-hidden`} aria-label="Sequence diagram">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="label">Sequence</h2>
          <span className="font-mono text-xs text-mute">
            {Math.min(cursor + 1, frames.length)}/{frames.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" className={buttonClass("ghost")} onClick={() => setCursor(0)} aria-label="First frame">
            ⏮
          </button>
          <button
            type="button"
            className={buttonClass("ghost")}
            onClick={() => setCursor((value) => Math.max(0, value - 1))}
            aria-label="Previous frame"
          >
            ◀
          </button>
          <button
            type="button"
            className={chipClass(playing)}
            onClick={() => {
              if (cursor >= frames.length - 1) setCursor(0);
              setPlaying((value) => !value);
            }}
          >
            {playing ? "Pause" : "Play"}
          </button>
          <button
            type="button"
            className={buttonClass("ghost")}
            onClick={() => setCursor((value) => Math.min(frames.length - 1, value + 1))}
            aria-label="Next frame"
          >
            ▶
          </button>
          <button
            type="button"
            className={buttonClass("ghost")}
            onClick={() => setCursor(frames.length - 1)}
            aria-label="Last frame"
          >
            ⏭
          </button>
        </div>
      </div>

      <div ref={scroller} className="max-h-[560px] overflow-auto">
        <svg
          viewBox={`0 0 640 ${height}`}
          className="block w-full"
          style={{ minWidth: 520 }}
          role="img"
          aria-label={`Sequence diagram with ${frames.length} frames`}
        >
          <defs>
            <marker id="arrow-out" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0 L8 4 L0 8 z" fill="currentColor" />
            </marker>
            <marker id="arrow-in" viewBox="0 0 8 8" refX="1" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M8 0 L0 4 L8 8 z" fill="currentColor" />
            </marker>
          </defs>

          <text x={LEFT} y={26} textAnchor="middle" className="fill-ink font-mono text-[11px]">
            client
          </text>
          <text x={640 - RIGHT} y={26} textAnchor="middle" className="fill-ink font-mono text-[11px]">
            server
          </text>

          <line x1={LEFT} y1={36} x2={LEFT} y2={height - 12} className="stroke-line" strokeWidth={1} />
          <line x1={640 - RIGHT} y1={36} x2={640 - RIGHT} y2={height - 12} className="stroke-line" strokeWidth={1} />

          {rows.map(({ frame, index, y, isCallback, isResponse, active, chosen }) => {
            const x1 = frame.dir === "out" ? LEFT : 640 - RIGHT;
            const x2 = frame.dir === "out" ? 640 - RIGHT : LEFT;
            const color = isCallback ? "text-sea" : isResponse ? "text-mute" : "text-ink";
            const dim = index > cursor;
            const text = label(frame);

            return (
              <g
                key={frame.i}
                data-row={index}
                className={`${color} cursor-pointer ${dim ? "opacity-25" : "opacity-100"}`}
                onClick={() => onSelect(chosen ? null : index)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") onSelect(chosen ? null : index);
                }}
              >
                <rect x={0} y={y - ROW / 2} width={640} height={ROW} className={chosen ? "fill-sunk" : "fill-transparent"} />
                {active ? <rect x={0} y={y - ROW / 2} width={3} height={ROW} className="fill-sea" /> : null}

                <line
                  x1={x1}
                  y1={y}
                  x2={x2}
                  y2={y}
                  stroke="currentColor"
                  strokeWidth={isCallback ? 2 : 1.5}
                  strokeDasharray={isResponse ? "4 3" : undefined}
                  markerEnd={frame.dir === "out" ? "url(#arrow-out)" : "url(#arrow-in)"}
                />

                <text
                  x={frame.dir === "out" ? LEFT + 8 : 640 - RIGHT - 8}
                  y={y - 5}
                  textAnchor={frame.dir === "out" ? "start" : "end"}
                  className="fill-current font-mono text-[10px]"
                >
                  {text}
                </text>

                {frame.latencyMs !== undefined ? (
                  <text
                    x={frame.dir === "out" ? 640 - RIGHT - 8 : LEFT + 8}
                    y={y - 5}
                    textAnchor={frame.dir === "out" ? "end" : "start"}
                    className="fill-mute font-mono text-[10px]"
                  >
                    {formatMs(frame.latencyMs)}
                  </text>
                ) : null}

                {isCallback ? (
                  <text x={320} y={y + 12} textAnchor="middle" className="fill-sea font-mono text-[9px]">
                    callback
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}
