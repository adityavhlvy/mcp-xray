import type { TreeNode } from "../lib/trace";
import { formatMs, label } from "../lib/trace";
import { panelClass } from "./controls";

interface Props {
  nodes: TreeNode[];
  selected: number | null;
  onSelect: (index: number | null) => void;
}

function Row({ node, depth, selected, onSelect }: { node: TreeNode; depth: number; selected: number | null; onSelect: (index: number | null) => void }) {
  const { frame } = node;
  const chosen = frame.i === selected;
  const isCallback = frame.kind === "request" && frame.dir === "in";

  return (
    <>
      <li>
        <button
          type="button"
          onClick={() => onSelect(chosen ? null : frame.i)}
          className={`flex w-full items-center gap-2 py-2 pr-3 text-left text-sm transition-colors hover:bg-sunk ${
            chosen ? "bg-sunk" : ""
          }`}
          style={{ paddingLeft: 12 + depth * 18 }}
        >
          <span className={`font-mono text-[10px] ${isCallback ? "text-sea" : "text-mute"}`}>
            {frame.dir === "out" ? "→" : "←"}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{label(frame)}</span>
          {node.inferred ? (
            <span className="shrink-0 border border-line px-1 font-mono text-[9px] text-mute" title="Parent inferred from timing">
              inferred
            </span>
          ) : null}
          {frame.latencyMs !== undefined ? (
            <span className="shrink-0 font-mono text-[10px] text-mute">{formatMs(frame.latencyMs)}</span>
          ) : null}
        </button>
      </li>
      {node.children.map((child) => (
        <Row key={child.frame.i} node={child} depth={depth + 1} selected={selected} onSelect={onSelect} />
      ))}
    </>
  );
}

export function CallTree({ nodes, selected, onSelect }: Props) {
  return (
    <section className={`${panelClass}`} aria-label="Call tree">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className="label">Call tree</h2>
        <span className="font-mono text-[10px] text-mute">parent links are inferred</span>
      </div>
      {nodes.length === 0 ? (
        <p className="p-4 text-sm text-mute">No requests in this trace.</p>
      ) : (
        <ul className="max-h-[320px] overflow-auto py-1">
          {nodes.map((node) => (
            <Row key={node.frame.i} node={node} depth={0} selected={selected} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </section>
  );
}
