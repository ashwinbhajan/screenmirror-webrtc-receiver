const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function receiver(consoleOverride = console) {
  const context = { console: consoleOverride, TextEncoder, URL, setTimeout, clearTimeout, globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "receiver.js"), "utf8"), context);
  return context.ScreenMirrorReceiverCapabilityGate;
}

test("accepts only the bounded ws endpoint shape", () => {
  const gate = receiver();
  assert.equal(gate.validEndpoint("ws://192.168.1.10:1234/" + "a".repeat(64)), true);
  assert.equal(gate.validEndpoint("wss://192.168.1.10:1234/" + "a".repeat(64)), false);
  assert.equal(gate.validEndpoint("ws://192.168.1.10:1234/short"), false);
});

test("rejects malformed or oversized capability commands", () => {
  const gate = receiver();
  assert.equal(gate.validateProbe('{"type":"probeEndpoint"}'), null);
  assert.equal(gate.validateProbe("x".repeat(1025)), null);
});

test("pins the planned AVC MIME type", () => {
  assert.equal(receiver().MIME_TYPE, 'video/mp4; codecs="avc1.42e01f"');
});

test("does not expose endpoint data in the safe capability snapshot", () => {
  assert.deepEqual(Object.keys(receiver().snapshot()).sort(), ["autoplay", "avcMIME", "mediaSource", "probeAckStatus", "sourceBuffer", "terminalStatus", "webSocketAPI", "websocketAttempted", "websocketAuthenticated", "websocketLifecycle"]);
  assert.equal(receiver().snapshot().autoplay, "deferred");
});

test("uses the explicit mixed-content stop classification", () => {
  assert.equal(receiver().RESULT.MIXED_CONTENT_BLOCKED, "websocket_mixed_content_blocked");
});

test("seeks only when playback has fallen behind the live buffered range", () => {
  const gate = receiver();
  assert.equal(gate.recoverySeekTarget(29.864, 31.035, 32.069), 31.085);
  assert.equal(gate.recoverySeekTarget(31.2, 31.035, 32.069), null);
  assert.equal(gate.recoverySeekTarget(79.18, 26.585, 29.751), 29.701);
  assert.equal(gate.recoverySeekTarget(29.864, 31.035, 31.035), null);
});

test("seeks near the live edge only after a stalled playhead has playable media ahead", () => {
  const gate = receiver();
  assert.equal(gate.stalledLiveEdgeSeekTarget(31.298, 28.002, 31.369), 31.319);
  assert.equal(gate.stalledLiveEdgeSeekTarget(31.34, 28.002, 31.369), null);
  assert.equal(gate.stalledLiveEdgeSeekTarget(30, 28, 30.04), null);
});

test("does not change credit emission while adding playback recovery helpers", () => {
  const messages = [];
  const emitCredit = receiver({ info: () => {} }).createMediaCreditEmitter(1, (message) => messages.push(message));
  emitCredit(); emitCredit();
  assert.deepEqual(JSON.parse(JSON.stringify(messages.map((message) => message.creditSequence))), [1, 2]);
});

test("declares bounded receiver-stop cleanup diagnostics", () => {
  const gate = receiver();
  assert.equal(gate.receiverRevision, "corr-fragseq-20260920-presentation");
  assert.deepEqual(JSON.parse(JSON.stringify(gate.receiverStopDiagnostics)), ["receiver_stop_received", "receiver_video_cleared", "receiver_idle_screen_shown", "receiver_casting_stopped_screen_shown", "receiver_connection_lost_screen_shown"]);
});

test("retains a bounded GOP history before trimming buffered media", () => {
  const gate = receiver();
  assert.equal(gate.bufferedTrimEnd(10, 8, 11), null);
  assert.equal(gate.bufferedTrimEnd(10, 5, 10.2), null);
  assert.equal(gate.bufferedTrimEnd(10, 5, 11), 7.5);
});

test("uses hysteresis to keep the media buffer near the live edge", () => {
  const gate = receiver();
  assert.equal(gate.liveEdgePlaybackRate(1.25, 1), 1.2);
  assert.equal(gate.liveEdgePlaybackRate(0.75, 1.2), 1);
  assert.equal(gate.liveEdgePlaybackRate(0.9, 1.2), null);
  assert.equal(gate.liveEdgePlaybackRate(NaN, 1), null);
});

test("emits only bounded correlation stage telemetry", () => {
  const gate = receiver();
  assert.deepEqual(JSON.parse(JSON.stringify(gate.makeLatencyStage(1, 7, "append_ended", 12.5, 400, 2))), {
    type: "latencyStage", generation: 1, sequence: 7, stage: "append_ended", receiverTimeMs: 12.5, bufferLeadMs: 400, pendingDepth: 2
  });
  assert.equal(gate.makeLatencyStage(1, 0, "append_ended", 12.5, 400, 2), null);
  assert.equal(gate.makeLatencyStage(1, 7, "unexpected", 12.5, 400, 2), null);
});

test("confirms first render only after a presented video frame", () => {
  const gate = receiver();
  assert.equal(gate.canConfirmFirstRendered(false, true, { presentedFrames: 1 }), true);
  assert.equal(gate.canConfirmFirstRendered(false, true, { presentedFrames: 0 }), false);
  assert.equal(gate.canConfirmFirstRendered(false, false, { presentedFrames: 1 }), false);
  assert.equal(gate.canConfirmFirstRendered(true, true, { presentedFrames: 2 }), false);
});

test("prefers media-time correlation and falls back only to appended fragment order", () => {
  const gate = receiver();
  assert.equal(gate.renderedCorrelationStrategy(true, true), "media_time");
  assert.equal(gate.renderedCorrelationStrategy(false, true), "append_order");
  assert.equal(gate.renderedCorrelationStrategy(false, false), "unavailable");
});

test("emits positive, monotonic media-credit sequences with receiver diagnostics", () => {
  const diagnostics = [];
  const messages = [];
  const gate = receiver({ info: (...args) => diagnostics.push(args) });
  const emitCredit = gate.createMediaCreditEmitter(1, (message) => messages.push(message));
  emitCredit();
  emitCredit();

  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
    { type: "mediaCredit", protocolVersion: 2, generation: 1, credits: 1, creditSequence: 1 },
    { type: "mediaCredit", protocolVersion: 2, generation: 1, credits: 1, creditSequence: 2 }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(diagnostics)), [
    ["ScreenMirror mediaCredit", { generation: 1, creditSequence: 1 }],
    ["ScreenMirror mediaCredit", { generation: 1, creditSequence: 2 }]
  ]);
});

test("resets media-credit sequence for a new receiver generation/session", () => {
  const gate = receiver({ info: () => {} });
  const firstGeneration = [];
  const nextGeneration = [];
  gate.createMediaCreditEmitter(1, (message) => firstGeneration.push(message))();
  gate.createMediaCreditEmitter(1, (message) => nextGeneration.push(message))();

  assert.equal(firstGeneration[0].creditSequence, 1);
  assert.equal(nextGeneration[0].creditSequence, 1);
});

function correlationHarness() {
  const diagnostics = []; const stages = []; const frames = [];
  const tracker = receiver().createFrameCorrelationTracker(1, (value) => diagnostics.push(value),
    (...value) => stages.push(value.slice(0, 3)), (...value) => frames.push(value));
  return { tracker, diagnostics, stages, frames };
}

test("late control binds appended fragment and replays original stages and pending render", () => {
  const { tracker, diagnostics, stages, frames } = correlationHarness();
  const fragment = tracker.receive(71, 12, 100);
  tracker.start(fragment, 110); tracker.append(fragment, 120);
  tracker.frame(130, { mediaTime: 12.02, presentedFrames: 1 });
  assert.equal(diagnostics.length, 0, "do not diagnose before late binding is exhausted");
  tracker.control({ generation: 1, sequence: 9, mediaTimeMs: 12000 }, 140);
  assert.deepEqual(diagnostics, ["frame_correlation_late_bound"]);
  assert.deepEqual(stages, [["received", 9, 100], ["append_started", 9, 110], ["append_ended", 9, 120]]);
  assert.equal(frames[0][0], 130);
  assert.equal(frames[0][2].sequence, 9, "envelope and latency sequence are independent");
  tracker.frame(150, { mediaTime: 12.04, presentedFrames: 2 });
  tracker.finish(160);
  assert.equal(frames.length, 1, "one latency sample per fragment without false uncorrelated callbacks");
  assert.equal(tracker.snapshot().counts.rendered_frame_uncorrelated_no_fragment_match, undefined);
});

test("late binding provides append-order fallback for subsequent rendered callback", () => {
  const { tracker, frames } = correlationHarness();
  const fragment = tracker.receive(1, 100, 0);
  tracker.start(fragment, 1); tracker.append(fragment, 2);
  tracker.control({ generation: 1, sequence: 25, mediaTimeMs: 100000 }, 3);
  tracker.frame(4, { mediaTime: 0, presentedFrames: 1 });
  assert.equal(frames.length, 1);
  assert.equal(frames[0][2].sequence, 25);
});

test("control before append and during append both retain correlation", () => {
  for (const early of [true, false]) {
    const { tracker, frames, diagnostics, stages } = correlationHarness();
    const control = { generation: 1, sequence: 3, mediaTimeMs: 5000 };
    if (early) tracker.control(control, 0);
    const fragment = tracker.receive(8, 5, 1); tracker.start(fragment, 2);
    if (!early) tracker.control(control, 3);
    tracker.append(fragment, 4); tracker.frame(5, { mediaTime: 5.1, presentedFrames: 1 });
    assert.equal(frames.length, 1); assert.equal(stages.length, 3);
    assert.equal(diagnostics.length, 0);
  }
});

test("nearest control and presentation range match tolerate rounded media timestamps", () => {
  const { tracker, frames, diagnostics } = correlationHarness();
  const fragment = tracker.receive(41, 20, 0);
  tracker.start(fragment, 1); tracker.append(fragment, 2);
  tracker.control({ generation: 1, sequence: 41, mediaTimeMs: 20240 }, 3);
  tracker.frame(4, { mediaTime: 20.22, presentedFrames: 1 });
  assert.equal(frames.length, 1);
  assert.equal(frames[0][2].sequence, 41);
  assert.deepEqual(diagnostics, ["frame_correlation_late_bound"]);
});

test("fragment sequence identity wins when control media time is offset", () => {
  const { tracker, frames, diagnostics } = correlationHarness();
  const fragment = tracker.receive(6, 13.968, 0);
  tracker.start(fragment, 1); tracker.append(fragment, 2);
  tracker.control({ generation: 1, sequence: 6, mediaTimeMs: 13434 }, 3);
  tracker.frame(4, { mediaTime: 13.95, presentedFrames: 1 });
  assert.equal(frames.length, 1);
  assert.equal(frames[0][2].sequence, 6);
  assert.equal(diagnostics.length, 1, "binding after append remains explicitly diagnosed");
  assert.equal(diagnostics[0], "frame_correlation_late_bound");
});

test("explicit fragment sequence binds when latency and envelope sequences diverge", () => {
  const { tracker, frames } = correlationHarness();
  const fragment = tracker.receive(71, 30, 0);
  tracker.start(fragment, 1); tracker.append(fragment, 2);
  tracker.control({ generation: 1, sequence: 7, fragmentSequence: 71, mediaTimeMs: 24000 }, 3);
  tracker.frame(4, { mediaTime: 30.1, presentedFrames: 1 });
  assert.equal(frames.length, 1);
  assert.equal(frames[0][2].sequence, 7, "sender latency sequence remains the stage and latency key");
});

test("failed control matching emits bounded numeric comparison diagnostics", () => {
  const { tracker, diagnostics } = correlationHarness();
  const fragment = tracker.receive(7, 3, 0);
  tracker.start(fragment, 1); tracker.append(fragment, 2);
  for (let i = 0; i < 20; i += 1) {
    tracker.control({ generation: 1, sequence: i + 1, mediaTimeMs: 100000 + i * 1000, capturePTS90k: 9_000 + i, captureDelta90k: 30 + i }, 3 + i);
  }
  const comparisons = diagnostics.filter((value) => value.startsWith("frame_correlation_control_no_match_"));
  assert.equal(comparisons.length, 8);
  assert.match(comparisons[0], /controlSeq_1_controlFragmentSeq_na_controlMediaMs_100000_controlCapturePTS90k_9000_controlCaptureDelta90k_30_nearestFragmentSeq_7_nearestMediaMs_3000_deltaMs_97000_generationMatch_1_retained_1_appended_1/);
});

test("fragment, orphan-control, callback retention and diagnostics remain bounded", () => {
  const { tracker, diagnostics } = correlationHarness();
  for (let i = 0; i < 1000; i += 1) {
    tracker.receive(i, i, i);
    tracker.control({ generation: 1, sequence: i + 1001, mediaTimeMs: (i + 10000) * 1000 }, i);
    tracker.frame(i, { mediaTime: -1, presentedFrames: i });
  }
  assert.equal(tracker.snapshot().fragments, 64);
  assert.equal(tracker.snapshot().controls, 64);
  assert.equal(tracker.snapshot().callbacks, 256);
  assert.equal(diagnostics.filter((value) => value === "frame_correlation_late_bind_expired").length, 8);
  tracker.finish(20000);
  assert.equal(tracker.snapshot().fragments, 0);
  assert.equal(tracker.snapshot().controls, 0);
  assert.equal(tracker.snapshot().callbacks, 0);
  assert.equal(tracker.snapshot().counts.rendered_frame_uncorrelated_no_fragment_match, 1000);
  assert.equal(diagnostics.filter((value) => value.startsWith("rendered_frame_uncorrelated")).length, 8);
});

test("expired fragments and wrong generations cannot bind", () => {
  const { tracker, frames, diagnostics } = correlationHarness();
  const fragment = tracker.receive(1, 1, 0); tracker.start(fragment, 1); tracker.append(fragment, 2);
  tracker.control({ generation: 2, sequence: 1, mediaTimeMs: 1000 }, 3);
  tracker.frame(4, { mediaTime: 1, presentedFrames: 1 });
  tracker.control({ generation: 1, sequence: 1, mediaTimeMs: 1000 }, 10000);
  tracker.finish(10005);
  assert.equal(frames.length, 0);
  assert.ok(diagnostics.includes("frame_correlation_late_bind_expired"));
  assert.equal(tracker.snapshot().counts.rendered_frame_uncorrelated_no_fragment_match, 1);
});

test("stop emits exactly one bounded full-session frame-pacing summary", () => {
  const messages = []; const pacing = receiver().createFramePacingSummary((value) => messages.push(value));
  [0, 5, 25, 65].forEach((time, i) => pacing.frame(time, { presentedFrames: [10, 11, 14, 15][i] }));
  [0, 30, 60].forEach((time) => pacing.append(time));
  const summary = pacing.stop({ rendered_frame_uncorrelated_no_fragment_match: 19, frame_correlation_late_bound: 5 });
  assert.equal(summary.render.count, 4);
  assert.equal(summary.render.p50Ms, 20); assert.equal(summary.render.p95Ms, 40); assert.equal(summary.render.maxMs, 40);
  assert.equal(summary.render.burstUnder8Ms, 1); assert.equal(summary.presentedJumps, 1);
  assert.equal(summary.presentedFramesDelta, 5); assert.equal(summary.presentedFPSMilli, 76923);
  assert.equal(summary.append.p50Ms, 30); assert.equal(summary.uncorrelated, 19);
  assert.equal(pacing.stop({}), null);
  pacing.frame(100, { presentedFrames: 16 });
  assert.equal(messages.length, 3);
  for (const message of messages) { assert.match(message, /^[a-zA-Z0-9_]+$/); assert.ok(message.length < 700); }
});

test("empty pacing and missing presentedFrames stay unavailable, not invented", () => {
  const pacing = receiver().createFramePacingSummary(() => {});
  const summary = pacing.stop({});
  assert.equal(summary.render.count, 0); assert.equal(summary.render.p95Ms, null);
  assert.equal(summary.presentedFPSMilli, null); assert.equal(summary.presentedFramesDelta, null);
});

test("pacing histogram covers long sessions with explicit overflow", () => {
  const pacing = receiver().createFramePacingSummary(() => {});
  for (let i = 0; i < 100000; i += 1) pacing.frame(i * 20, { presentedFrames: i });
  pacing.frame(2010000, { presentedFrames: 100000 });
  const summary = pacing.stop({});
  assert.equal(summary.render.count, 100001); assert.equal(summary.render.p95Ms, 20);
  assert.equal(summary.render.intervalOverflow, 1); assert.equal(summary.render.maxMs, 10020);
});

for (const ending of ["normal", "normalStop", "abnormal", "error"]) test(`${ending} socket closure clears video, presents safe copy and preserves pacing`, async () => {
  const messages = []; const sources = []; const sockets = []; const wire = []; const buffers = []; let receiverListener; let nextFrame; let cancelled = false; let now = 0;
  const nodes = {}; const classes = new Set(); const cleanup = []; const closes = []; const videoEvents = {}; const timers = [];
  const schedule = (callback) => { timers.push(callback); return timers.length; };
  const cancel = (id) => { timers[id - 1] = null; };
  const runPendingTimer = () => { const index = timers.findLastIndex(Boolean); const callback = timers[index]; timers[index] = null; callback(); };
  const video = { buffered: { length: 0 }, currentTime: 0, playbackRate: 1, pause() { cleanup.push("pause"); }, load() { cleanup.push("load"); }, removeAttribute(name) { cleanup.push(name); },
    addEventListener(name, callback) { videoEvents[name] = callback; }, requestVideoFrameCallback(callback) { nextFrame = callback; return 42; },
    cancelVideoFrameCallback(id) { cancelled = id === 42; } };
  class MediaSource {
    static isTypeSupported() { return true; }
    constructor() { this.listeners = {}; sources.push(this); }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    addSourceBuffer() { const buffer = { listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; }, appendBuffer() {} }; buffers.push(buffer); return buffer; }
  }
  class WebSocket { constructor() { this.readyState = 1; sockets.push(this); } send(value) { wire.push(JSON.parse(value)); } close(code, reason) { closes.push({ code, reason }); } }
  const context = { ArrayBuffer, Uint8Array, DataView, TextEncoder, URL: { createObjectURL: () => "blob:test" }, performance: { now: () => now }, setTimeout: schedule, clearTimeout: cancel, MediaSource, WebSocket,
    document: { readyState: "complete", getElementById: (id) => id === "probe-video" ? video : (nodes[id] ||= {}), body: { classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) } } },
    cast: { framework: { CastReceiverContext: { getInstance: () => ({ addCustomMessageListener: (_, callback) => { receiverListener = callback; }, start() {}, sendCustomMessage: (_, sender, message) => messages.push({ sender, ...message }) }) }, CastReceiverOptions: function () {}, system: { MessageType: { JSON: "JSON" } } } } };
  // URL must remain constructible for endpoint validation.
  context.URL = class extends URL { static createObjectURL() { return "blob:test"; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "receiver.js"), "utf8"), context);
  assert.equal(nodes["status-title"].textContent, "Ready to Cast");
  assert.equal(nodes["status-detail"].textContent, "Open the app on your iPhone to begin.");
  assert.ok(classes.has("receiver-waiting"));
  assert.equal(nodes["receiver-version"].textContent, `Receiver 2.0.0 · ${context.ScreenMirrorReceiverCapabilityGate.receiverRevision}`);
  sources[0].listeners.sourceopen(); await new Promise(setImmediate);
  receiverListener({ senderId: "sender", data: { type: "startMedia", protocolVersion: 2, requestId: "session_request", endpoint: "ws://192.168.1.1:1234/" + "a".repeat(64) } });
  await new Promise(setImmediate); sources[1].listeners.sourceopen(); sockets[0].onopen();
  assert.equal(nodes["status-title"].textContent, "Ready to Cast");
  assert.equal(nodes["status-detail"].textContent, "Open the app on your iPhone to begin.");
  videoEvents.waiting();
  assert.equal(nodes["status-title"].textContent, "Ready to Cast");
  videoEvents.playing(); assert.equal(nodes["idle-screen"].hidden, true);
  assert.equal(classes.has("receiver-waiting"), false);
  // A minimal valid moof/traf/mdat fixture, envelope sequence distinct from control sequence.
  const box = (name, payload) => { const result = Buffer.alloc(8 + payload.length); result.writeUInt32BE(result.length); result.write(name, 4); payload.copy(result, 8); return result; };
  const mfhd = Buffer.alloc(8); mfhd.writeUInt32BE(71, 4);
  const tfdt = Buffer.alloc(8);
  const trun = Buffer.alloc(12); trun.writeUInt32BE(1, 4); trun.writeUInt32BE(76, 8);
  const moof = box("moof", Buffer.concat([box("mfhd", mfhd), box("traf", Buffer.concat([box("tfdt", tfdt), box("trun", trun)]))]));
  const payload = Buffer.concat([moof, box("mdat", Buffer.from([0, 0, 0, 1, 0x65]))]);
  const header = Buffer.alloc(14); header.write("SMC1"); header[4] = 2; header[5] = 2; header.writeUInt32BE(71, 6); header.writeUInt32BE(payload.length, 10);
  const binary = Uint8Array.from(Buffer.concat([header, payload])).buffer;
  sockets[0].onmessage({ data: binary }); buffers[1].listeners.updateend();
  nextFrame(10, { mediaTime: 0, presentedFrames: 1 });
  videoEvents.waiting();
  assert.equal(nodes["status-title"].textContent, "Ready to Cast");
  runPendingTimer();
  assert.equal(nodes["idle-screen"].hidden, true, "a transient waiting event must not replace visible video");
  now = 1500;
  videoEvents.waiting();
  runPendingTimer();
  assert.equal(nodes["status-title"].textContent, "Reconnecting…");
  assert.equal(nodes["status-detail"].textContent, "Keep the app open on your iPhone.");
  assert.equal(nodes["idle-screen"].hidden, false);
  assert.ok(classes.has("receiver-waiting"));
  videoEvents.playing();
  sockets[0].onmessage({ data: JSON.stringify({ type: "frameCorrelation", generation: 1, sequence: 9, mediaTimeMs: 0 }) }); nextFrame(30, { mediaTime: 0.02, presentedFrames: 2 });
  if (ending === "error") sockets[0].onerror();
  if (ending === "normalStop") sockets[0].onmessage({ data: JSON.stringify({ type: "normalStop", protocolVersion: 2 }) });
  const closeEvent = { code: ending === "abnormal" ? 1006 : 1000, wasClean: ending !== "abnormal" };
  const deliveredClose = ending === "normalStop" ? { code: 1006, wasClean: false } : closeEvent;
  sockets[0].onclose(deliveredClose); sockets[0].onclose(deliveredClose);
  const stopped = ending === "normal" || ending === "normalStop";
  assert.deepEqual(cleanup, ["pause", "src", "load"]);
  assert.equal(classes.has("media-active"), false);
  assert.equal(classes.has("receiver-waiting"), false);
  assert.equal(nodes["idle-screen"].hidden, false);
  assert.equal(nodes["status-title"].textContent, stopped ? "Casting Stopped" : "Connection Lost");
  assert.equal(nodes["status-detail"].textContent, stopped ? "Ready when you are. Start casting again from your iPhone." : "We’re waiting for your iPhone. Check Wi‑Fi and start casting again.");
  assert.equal(messages.filter((value) => value.result === "receiver_stop_received").length, 1);
  assert.equal(messages.filter((value) => value.result === "receiver_idle_screen_shown").length, 1);
  assert.equal(messages.filter((value) => value.result === "receiver_casting_stopped_screen_shown").length, stopped ? 1 : 0);
  assert.equal(messages.filter((value) => value.result === "receiver_connection_lost_screen_shown").length, stopped ? 0 : 1);
  if (ending === "normalStop") assert.deepEqual(closes, [{ code: 1000, reason: "normal_stop" }]);
  videoEvents.playing(); videoEvents.waiting(); videoEvents.stalled();
  assert.equal(nodes["idle-screen"].hidden, false);
  assert.equal(classes.has("receiver-waiting"), false);
  const summary = messages.filter((value) => value.result && value.result.startsWith("frame_pacing_summary_"));
  assert.equal(summary.length, 3); assert.ok(cancelled);
  assert.deepEqual(wire.filter((value) => value.type === "latencyStage").map((value) => value.stage), ["received", "append_started", "append_ended"]);
  const rendered = wire.filter((value) => value.type === "renderedFrame");
  assert.equal(rendered.length, 1); assert.equal(rendered[0].sequence, 9); assert.equal(rendered[0].receiverTimeMs, 10);
  assert.ok(messages.some((value) => value.result === "frame_correlation_late_bound"));
  assert.ok(summary[0].result.includes("count_2"));
  assert.ok(summary[2].result.includes("uncorrelated_no_fragment_match_0"));
  for (const message of summary) { assert.equal(message.requestId, "session_request"); assert.equal(message.sender, "sender"); assert.ok(JSON.stringify(message).length < 1024); }
  assert.ok(messages.findIndex((value) => value.result === "receiver_video_cleared") > messages.indexOf(summary[2]));
  nextFrame(50, { mediaTime: 0.04, presentedFrames: 3 });
  assert.equal(messages.filter((value) => value.result && value.result.startsWith("frame_pacing_summary_")).length, 3);
});

test("receiver presentation waits for sustained missing playback before showing reconnecting", () => {
  const gate = receiver();
  assert.equal(gate.shouldShowReconnectingScreen(true, false, 1000, 1349, 1500), false);
  assert.equal(gate.shouldShowReconnectingScreen(true, false, 1000, 2500, 1500), true);
  assert.equal(gate.shouldShowReconnectingScreen(false, false, 1000, 3000, 1500), false);
  assert.equal(gate.shouldShowReconnectingScreen(true, true, 1000, 3000, 1500), false);
});

test("late-bound stage replay preserves original buffer lead and queue snapshots", () => {
  const stages = [];
  const tracker = receiver().createFrameCorrelationTracker(1, () => {}, (...values) => stages.push(values), () => {});
  const fragment = tracker.receive(1, 5, 10, { bufferLeadMs: 20, pendingDepth: 2 });
  tracker.start(fragment, 20, { bufferLeadMs: 15, pendingDepth: 1 });
  tracker.append(fragment, 30, { bufferLeadMs: 150, pendingDepth: 0 });
  tracker.control({ generation: 1, sequence: 7, mediaTimeMs: 5000 }, 100);
  assert.deepEqual(stages, [
    ["received", 7, 10, { bufferLeadMs: 20, pendingDepth: 2 }],
    ["append_started", 7, 20, { bufferLeadMs: 15, pendingDepth: 1 }],
    ["append_ended", 7, 30, { bufferLeadMs: 150, pendingDepth: 0 }]
  ]);
});

test("ordered fallback waits for older unresolved append instead of consuming a newer correlation", () => {
  const { tracker, frames } = correlationHarness();
  const first = tracker.receive(1, 100, 0); tracker.start(first, 1); tracker.append(first, 2);
  const second = tracker.receive(2, 101, 3); tracker.start(second, 4); tracker.append(second, 5);
  tracker.control({ generation: 1, sequence: 20, mediaTimeMs: 101000 }, 6);
  tracker.frame(7, { mediaTime: 100, presentedFrames: 1 });
  assert.equal(frames.length, 0);
  tracker.control({ generation: 1, sequence: 10, mediaTimeMs: 100000 }, 8);
  assert.equal(frames.length, 1); assert.equal(frames[0][2].sequence, 10);
});


test("only a clean normal close is presented as stopped", () => {
  const gate = receiver();
  assert.equal(gate.closeScreen({ code: 1000, wasClean: true }, false), "stopped");
  for (const event of [undefined, { code: 1006, wasClean: false }, { code: 1001, wasClean: true }, { code: 1000, wasClean: false }]) {
    assert.equal(gate.closeScreen(event, false), "lost");
  }
  assert.equal(gate.closeScreen({ code: 1000, wasClean: true }, true), "lost");
});

test("TV markup contains no developer panel and pins both presentation assets", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "receiver.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
  assert.doesNotMatch(html, /<dl>|id="last-event"|id="connection-state"|capability gate|scope-note/i);
  assert.ok(html.includes(`receiver.js?rev=${receiver().receiverRevision}`));
  assert.ok(html.includes(`styles.css?rev=${receiver().receiverRevision}`));
  assert.ok(html.includes(`assets/cast-device-icon.png?rev=${receiver().receiverRevision}`));
  assert.match(html, /alt="Screen Mirror"/);
  assert.match(css, /system-ui/);
  assert.ok(fs.statSync(path.join(__dirname, "..", "assets", "cast-device-icon.png")).size <= 256 * 1024);
  assert.match(html, /aria-atomic="true"/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /receiver-status\[hidden\]/);
});
