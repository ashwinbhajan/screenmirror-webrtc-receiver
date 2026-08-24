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
