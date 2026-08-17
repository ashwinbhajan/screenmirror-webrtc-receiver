const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function receiver() {
  const context = { console, TextEncoder, URL, setTimeout, clearTimeout, globalThis: null };
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
  assert.deepEqual(Object.keys(receiver().snapshot()).sort(), ["autoplay", "avcMIME", "mediaSource", "probeAckStatus", "sourceBuffer", "terminalStatus", "webSocketAPI", "websocketAttempted", "websocketAuthenticated"]);
  assert.equal(receiver().snapshot().autoplay, "deferred");
});

test("uses the explicit mixed-content stop classification", () => {
  assert.equal(receiver().RESULT.MIXED_CONTENT_BLOCKED, "websocket_mixed_content_blocked");
});
