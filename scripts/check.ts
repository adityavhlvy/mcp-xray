// Runnable checks for the parts that are easy to break: frame classification,
// SSE parsing, latency pairing, redaction, the SSRF guard, and the call tree.
// Run with `bun run check`.
import { classify, linkLatency, makeFrame, messagesFromBody, parseSse, redact } from "../shared/frame.js";
import type { Frame } from "../shared/types.js";
import { isPrivateAddress, isPrivateV4, isPrivateV6 } from "../server/guard.js";
import { callTree, hexDump, lifecycleAt, spans, stats, surface } from "../src/lib/trace.js";
import { TEXTBOOK } from "../src/lib/textbook.js";

let failures = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failures++;
  console.log(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

// Classification
check("request has method and id", classify({ jsonrpc: "2.0", id: 1, method: "ping" }) === "request");
check("notification has method, no id", classify({ jsonrpc: "2.0", method: "notifications/initialized" }) === "notification");
check("result is a response", classify({ jsonrpc: "2.0", id: 1, result: {} }) === "response");
check("error is an error", classify({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "x" } }) === "error");
check("null id is a notification", classify({ jsonrpc: "2.0", id: null, method: "x" }) === "notification");

// SSE
const sse = [
  "event: message",
  'data: {"jsonrpc":"2.0","id":1,"result":{}}',
  "",
  ": keep-alive",
  "",
  "data: {",
  'data:   "jsonrpc": "2.0",',
  'data:   "method": "notifications/progress"',
  "data: }",
  "",
].join("\n");
const parsed = parseSse(sse);
check("sse splits events", parsed.length === 2, String(parsed.length));
check("sse keeps multi-line data", parsed[1]?.includes("notifications/progress") === true);
check("sse ignores comments", !parsed.some((message) => message.includes("keep-alive")));

check("plain json body is one message", messagesFromBody('{"a":1}', "application/json").length === 1);
check("batch body splits", messagesFromBody('[{"a":1},{"b":2}]', "application/json").length === 2);
check("empty body is nothing", messagesFromBody("   ", "application/json").length === 0);

// Latency pairing
const frames: Frame[] = [
  makeFrame({ i: 0, t: 0, dir: "out", raw: '{"jsonrpc":"2.0","id":1,"method":"ping"}' }),
  makeFrame({ i: 1, t: 25, dir: "in", raw: '{"jsonrpc":"2.0","id":1,"result":{}}' }),
];
linkLatency(frames);
check("latency is paired", frames[1].latencyMs === 25, String(frames[1].latencyMs));

const crossed: Frame[] = [
  makeFrame({ i: 0, t: 0, dir: "out", raw: '{"jsonrpc":"2.0","id":1,"method":"ping"}' }),
  makeFrame({ i: 1, t: 10, dir: "in", raw: '{"jsonrpc":"2.0","id":2,"method":"sampling/createMessage"}' }),
  makeFrame({ i: 2, t: 20, dir: "out", raw: '{"jsonrpc":"2.0","id":2,"result":{}}' }),
  makeFrame({ i: 3, t: 30, dir: "in", raw: '{"jsonrpc":"2.0","id":1,"result":{}}' }),
];
linkLatency(crossed);
check("crossed ids pair by direction", crossed[3].latencyMs === 30 && crossed[2].latencyMs === 10);

// Redaction
const redacted = redact({ authorization: "Bearer abcdef", nested: { apiKey: "secret", keep: "yes" } }) as Record<string, unknown>;
check("authorization is redacted", String(redacted.authorization).startsWith("[redacted"));
check("apiKey is redacted", String((redacted.nested as Record<string, unknown>).apiKey).startsWith("[redacted"));
check("other keys survive", (redacted.nested as Record<string, unknown>).keep === "yes");

// SSRF guard
check("blocks 10/8", isPrivateV4("10.1.2.3"));
check("blocks 127.0.0.1", isPrivateV4("127.0.0.1"));
check("blocks 169.254.169.254", isPrivateV4("169.254.169.254"));
check("blocks 172.16/12", isPrivateV4("172.20.1.1"));
check("allows 172.32", !isPrivateV4("172.32.0.1"));
check("blocks 192.168/16", isPrivateV4("192.168.1.1"));
check("blocks 100.64/10", isPrivateV4("100.100.1.1"));
check("allows 8.8.8.8", !isPrivateV4("8.8.8.8"));
check("blocks ::1", isPrivateV6("::1"));
check("blocks fe80", isPrivateV6("fe80::1"));
check("blocks fd00", isPrivateV6("fd00::1"));
check("blocks mapped v4", isPrivateV6("::ffff:10.0.0.1"));
check("allows public v6", !isPrivateV6("2606:4700:4700::1111"));
check("isPrivateAddress handles v4", isPrivateAddress("10.0.0.1"));
check("isPrivateAddress handles v6", isPrivateAddress("::1"));

// Trace analysis
const trace = TEXTBOOK.find((entry) => entry.id === "callback")!.trace;
const tree = callTree(trace);
check("callback trace has a root", tree.length > 0);
const callbackNode = tree.flatMap((node) => node.children).find((node) => node.frame.method === "sampling/createMessage");
check("callback is nested under a request", callbackNode !== undefined);
check("callback is marked inferred", callbackNode?.inferred === true);

const numbers = stats(trace);
check("stats count callbacks", numbers.callbacks === 1, String(numbers.callbacks));
check("stats count requests", numbers.requests === 3, String(numbers.requests));

check("lifecycle starts uninitialized", lifecycleAt(trace, 0) === "initializing");
check("lifecycle reaches initialized", lifecycleAt(trace, trace.frames.length - 1) === "initialized");

const caps = surface(trace);
check("surface reads tools", caps.tools);
check("surface reads sampling as absent", !caps.sampling);

const timeline = spans(trace);
check("spans pair every request", timeline.length === 3, String(timeline.length));

check("hex dump has offsets", hexDump("hello").length === 1 && hexDump("hello")[0].startsWith("000000"));

// Every textbook trace must be internally consistent.
for (const entry of TEXTBOOK) {
  const linked = linkLatency(entry.trace.frames.map((frame) => ({ ...frame })));
  const requests = linked.filter((frame) => frame.kind === "request");
  const responses = linked.filter((frame) => frame.kind === "response" || frame.kind === "error");
  check(`textbook ${entry.id} has frames`, linked.length > 0);
  check(`textbook ${entry.id} pairs requests`, requests.length === responses.length, `${requests.length} vs ${responses.length}`);
  check(
    `textbook ${entry.id} is ordered`,
    linked.every((frame, index) => index === 0 || frame.t >= linked[index - 1].t),
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
