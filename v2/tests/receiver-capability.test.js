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
