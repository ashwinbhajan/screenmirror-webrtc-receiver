"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "receiver.js"), "utf8");
const sandbox = {
  TextEncoder,
  console: { info() {} },
  globalThis: null
};
sandbox.globalThis = sandbox;
vm.runInNewContext(source, sandbox, { filename: "receiver.js" });

const bootstrap = sandbox.ScreenMirrorReceiverBootstrap;
const validPing = Object.freeze({
  type: "ping",
  protocolVersion: 1,
  requestId: "run-01.ping_1",
  timestampMs: 1_700_000_000_000
});

test("accepts a bounded protocol-v1 ping object", () => {
  const result = bootstrap.validatePing(validPing);
  assert.equal(result.ok, true);
  assert.equal(result.value.requestId, validPing.requestId);
});

test("accepts an equivalent JSON string", () => {
  const result = bootstrap.validatePing(JSON.stringify(validPing));
  assert.equal(result.ok, true);
  assert.equal(result.value.requestId, validPing.requestId);
});

test("rejects malformed JSON, unexpected fields, and unsupported versions", () => {
  assert.equal(bootstrap.validatePing("{").code, "malformed_json");
  assert.equal(bootstrap.validatePing({ ...validPing, secret: "do-not-log" }).code, "unexpected_field");
  assert.equal(bootstrap.validatePing({ ...validPing, protocolVersion: 2 }).code, "unsupported_protocol_version");
});

test("rejects invalid request IDs, timestamps, and oversized payloads", () => {
  assert.equal(bootstrap.validatePing({ ...validPing, requestId: "has a space" }).code, "invalid_request_id");
  assert.equal(bootstrap.validatePing({ ...validPing, timestampMs: -1 }).code, "invalid_timestamp");
  assert.equal(bootstrap.validatePing("x".repeat(bootstrap.maxMessageBytes + 1)).code, "message_too_large");
});

test("ack mirrors only the request ID and emits the fixed receiver version", () => {
  const ack = bootstrap.makeAck(validPing.requestId, 42);
  assert.equal(ack.type, "ack");
  assert.equal(ack.protocolVersion, 1);
  assert.equal(ack.requestId, validPing.requestId);
  assert.equal(ack.receiverVersion, "1.0.0");
  assert.equal(ack.timestampMs, 42);
});
