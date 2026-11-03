const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const receiverSourcePath = process.env.SCREENMIRROR_RECEIVER_PATH || path.join(__dirname, "..", "receiver.js");

function gate() {
  const context = { ArrayBuffer, Uint8Array, DataView, TextEncoder, URL, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(receiverSourcePath, "utf8"), context);
  return context.ScreenMirrorReceiverCapabilityGate;
}

function sample(changes = {}) {
  return {
    runID: 1, nowMs: 0, currentTime: 10,
    videoRanges: [{ start: 0, end: 19 }], audioRanges: [], syncPoints: [12, 15, 17],
    audioRequested: false, audioReady: false, audioUpdating: false,
    readyState: 4, paused: false, ended: false, seeking: false, mediaError: false,
    sourceOpen: true, videoUpdating: false, pendingDepth: 0,
    progressAgeMs: 100, appendAgeMs: 100, renderAgeMs: 100,
    ...changes
  };
}

function videoFragment(flag = 0x02000000, decodeTime90k = 17 * 90000, sequence = 1) {
  const flags = Array.isArray(flag) ? flag : [flag];
  const box = (name, body) => { const bytes = Buffer.alloc(8 + body.length); bytes.writeUInt32BE(bytes.length); bytes.write(name, 4); body.copy(bytes, 8); return bytes; };
  const mfhd = Buffer.alloc(8); mfhd.writeUInt32BE(sequence, 4);
  const tfdt = Buffer.alloc(12); tfdt.writeBigUInt64BE(BigInt(decodeTime90k), 4); tfdt[0] = 1;
  const trun = Buffer.alloc(12 + flags.length * 12); trun.writeUIntBE(0x000701, 1, 3);
  trun.writeUInt32BE(flags.length, 4);
  for (let index = 0; index < flags.length; index += 1) {
    trun.writeUInt32BE(9000, 12 + index * 12);
    trun.writeUInt32BE(5, 16 + index * 12);
    trun.writeUInt32BE(flags[index], 20 + index * 12);
  }
  const makeMoof = () => box("moof", Buffer.concat([box("mfhd", mfhd),
    box("traf", Buffer.concat([box("tfdt", tfdt), box("trun", trun)]))]));
  trun.writeUInt32BE(makeMoof().length + 8, 8);
  const mdat = box("mdat", Buffer.concat(flags.map((value) => Buffer.from([0, 0, 0, 1,
    value === 0x02000000 ? 0x65 : 0x41]))));
  return Uint8Array.from(Buffer.concat([makeMoof(), mdat])).buffer;
}

test("a healthy 9-second gap persists 2.5 seconds before seeking to an appended sync sample", () => {
  const policy = gate().createHealthyLiveEdgeCatchup(1);
  assert.equal(policy.consider(sample()), null);
  assert.equal(policy.consider(sample({ nowMs: 2499 })), null);
  assert.equal(policy.consider(sample({ nowMs: 2500 })), 17);
  assert.equal(policy.consider(sample({ nowMs: 3000 })), null, "seek remains pending");
});

test("normal 1–2-second playback and genuine stalls never enter healthy catch-up", () => {
  const policy = gate().createHealthyLiveEdgeCatchup(1);
  for (const nowMs of [0, 2500, 10000]) {
    assert.equal(policy.consider(sample({ nowMs, currentTime: 17.5 })), null);
  }
  for (const changes of [
    { progressAgeMs: 1600 }, { renderAgeMs: 1600 }, { appendAgeMs: 1600 },
    { readyState: 2 }, { paused: true }, { seeking: true },
    { mediaError: true }, { sourceOpen: false }, { pendingDepth: 3 }
  ]) {
    assert.equal(policy.consider(sample({ nowMs: 15000, ...changes })), null);
  }
  assert.equal(policy.consider(sample({ nowMs: 17000 })), null, "unhealthy observations reset persistence");
});

test("fragmented ranges use the range containing the playhead and reject unbuffered targets", () => {
  const policy = gate().createHealthyLiveEdgeCatchup(1);
  const fragmented = { videoRanges: [{ start: 0, end: 11 }, { start: 15, end: 19 }] };
  assert.equal(policy.consider(sample(fragmented)), null);
  assert.equal(policy.consider(sample({ nowMs: 3000, ...fragmented })), null);
  assert.equal(policy.consider(sample({ nowMs: 6000, videoRanges: [{ start: 11, end: 19 }] })), null,
    "a playhead in a gap is not a healthy catch-up case");
  const noSync = gate().createHealthyLiveEdgeCatchup(1);
  assert.equal(noSync.consider(sample({ syncPoints: [11, 19] })), null);
  assert.equal(noSync.consider(sample({ nowMs: 3000, syncPoints: [11, 19] })), null,
    "do not seek to an unverified or edge-adjacent point");
});

test("seek completion, 3-second rearm and 10-second cooldown prevent oscillation", () => {
  const policy = gate().createHealthyLiveEdgeCatchup(1);
  policy.consider(sample());
  assert.equal(policy.consider(sample({ nowMs: 2500 })), 17);
  policy.completeSeek(1);
  assert.equal(policy.consider(sample({ nowMs: 14000 })), null, "high lead alone cannot rearm");
  assert.equal(policy.consider(sample({ nowMs: 14100, currentTime: 17 })), null);
  assert.equal(policy.consider(sample({ nowMs: 14200 })), null);
  assert.equal(policy.consider(sample({ nowMs: 16699 })), null);
  assert.equal(policy.consider(sample({ nowMs: 16700 })), 17);
  policy.close();
  assert.equal(policy.consider(sample({ nowMs: 30000 })), null);
});

test("stale run observations and completion cannot advance another receiver generation", () => {
  const policy = gate().createHealthyLiveEdgeCatchup(1);
  assert.equal(policy.consider(sample({ runID: 2 })), null);
  assert.equal(policy.consider(sample({ runID: 2, nowMs: 5000 })), null);
  assert.equal(policy.consider(sample({ nowMs: 5000 })), null);
  assert.equal(policy.consider(sample({ nowMs: 7500 })), 17);
  policy.completeSeek(2);
  assert.equal(policy.consider(sample({ nowMs: 20000 })), null, "stale completion cannot clear pending seek");
});

test("AAC catch-up requires one common audio/video range and never enters an audio gap", () => {
  const noAudio = gate().createHealthyLiveEdgeCatchup(1);
  const audio = { audioRequested: true, audioReady: true, audioRanges: [{ start: 0, end: 18.5 }] };
  assert.equal(noAudio.consider(sample({ ...audio, audioReady: false })), null);
  assert.equal(noAudio.consider(sample({ ...audio, nowMs: 3000, audioReady: false })), null);
  assert.equal(noAudio.consider(sample({ ...audio, nowMs: 4000 })), null);
  assert.equal(noAudio.consider(sample({ ...audio, nowMs: 6500 })), 17);

  const gap = gate().createHealthyLiveEdgeCatchup(1);
  const fragmentedAudio = { ...audio, audioRanges: [{ start: 0, end: 12 }, { start: 16, end: 18.5 }] };
  assert.equal(gap.consider(sample(fragmentedAudio)), null);
  assert.equal(gap.consider(sample({ ...fragmentedAudio, nowMs: 3000 })), null);
  const updating = gate().createHealthyLiveEdgeCatchup(1);
  assert.equal(updating.consider(sample({ ...audio, audioUpdating: true })), null);
  assert.equal(updating.consider(sample({ ...audio, audioUpdating: true, nowMs: 3000 })), null);
});

test("sync points require the sender's first-sample random-access flag", () => {
  assert.equal(gate().summarizeFragment(videoFragment(0x02000000)).syncStart, true);
  assert.equal(gate().summarizeFragment(videoFragment(0x01010000)).syncStart, false);
  const middle = gate().summarizeFragment(videoFragment([0x01010000, 0x02000000]));
  assert.equal(middle.syncStart, false);
  assert.deepEqual(Array.from(middle.syncTimes), [17.1], "a mid-fragment IDR is still a decodable seek point");
});

test("live receiver events seek once to the appended sync sample after sustained healthy delay", async () => {
  const sources = []; const sockets = []; const messages = []; const events = {}; let receive; let frame; let now = 0;
  const ranges = { length: 1, start: () => 0, end: () => 19 };
  const video = { currentTime: 10, buffered: ranges, readyState: 4, paused: false,
    seeking: false, ended: false, muted: true, playbackRate: 1,
    addEventListener(name, callback) { events[name] = callback; },
    requestVideoFrameCallback(callback) { frame = callback; return 1; },
    play() { return Promise.resolve(); }, pause() {}, removeAttribute() {}, load() {} };
  class MediaSource {
    static isTypeSupported() { return true; }
    constructor() { this.readyState = "open"; this.listeners = {}; sources.push(this); }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    addSourceBuffer() {
      const buffer = { buffered: ranges, updating: false, listeners: {},
        addEventListener(name, callback) { this.listeners[name] = callback; }, appendBuffer() {}, remove() {} };
      this.registeredBuffer = buffer; return buffer;
    }
  }
  class WebSocket {
    constructor() { this.readyState = 1; sockets.push(this); }
    send() {} close() {}
  }
  const nodes = {};
  const context = { ArrayBuffer, Uint8Array, DataView, TextEncoder, URL,
    performance: { now: () => now }, setTimeout: () => 1, clearTimeout() {},
    setInterval: () => 1, clearInterval() {}, MediaSource, WebSocket,
    document: { readyState: "complete", getElementById: (id) => id === "probe-video" ? video : (nodes[id] ||= {}),
      body: { classList: { add() {}, remove() {} } } },
    cast: { framework: { CastReceiverContext: { getInstance: () => ({ addEventListener() {},
      addCustomMessageListener: (_, callback) => { receive = callback; }, start() {},
      sendCustomMessage: (_, __, message) => messages.push(message) }) },
      CastReceiverOptions: function () {}, system: { EventType: { READY: "ready", SENDER_CONNECTED: "sender_connected" },
        MessageType: { JSON: "JSON" } } } } };
  context.URL = class extends URL { static createObjectURL() { return "blob:test"; } };
  vm.runInNewContext(fs.readFileSync(receiverSourcePath, "utf8"), context);
  sources[0].listeners.sourceopen(); await new Promise(setImmediate);
  receive({ senderId: "sender", data: { type: "startMedia", protocolVersion: 2, requestId: "catchup",
    endpoint: "ws://192.168.1.1:1234/" + "a".repeat(64) } });
  await new Promise(setImmediate);
  sources[1].listeners.sourceopen(); sockets[0].onopen();
  sockets[0].onmessage({ data: JSON.stringify({ type: "readyForMedia", protocolVersion: 2 }) });
  const sendVideo = (type, payload, sequence) => {
    const bytes = Buffer.alloc(14 + payload.byteLength); bytes.write("SMC1"); bytes[4] = 2; bytes[5] = type;
    bytes.writeUInt32BE(sequence, 6); bytes.writeUInt32BE(payload.byteLength, 10);
    Buffer.from(payload).copy(bytes, 14);
    sockets[0].onmessage({ data: Uint8Array.from(bytes).buffer });
  };
  const registered = sources[1].registeredBuffer;
  sendVideo(1, Uint8Array.from([1]).buffer, 0);
  registered.listeners.updateend();
  sendVideo(2, videoFragment(0x02000000, 17 * 90000, 1), 1);
  registered.listeners.updateend();
  await new Promise(setImmediate);
  now = 100; frame(now, { mediaTime: 10, presentedFrames: 1, processingDuration: 0.01, expectedDisplayTime: 116 });
  events.timeupdate();
  for (let i = 1; i <= 5; i += 1) {
    now = 100 + i * 500;
    video.currentTime = 10 + i * 0.5;
    frame(now, { mediaTime: video.currentTime, presentedFrames: i + 1,
      processingDuration: 0.01, expectedDisplayTime: now + 16 });
    sendVideo(2, videoFragment(0x01010000, (17 + i) * 90000, i + 1), i + 1);
    registered.listeners.updateend();
    events.timeupdate();
  }
  assert.equal(video.currentTime, 17);
  assert.equal(messages.filter((message) => message.result === "healthy_live_edge_catchup_seek").length, 1);
  events.seeked();
  assert.equal(messages.filter((message) => message.result === "healthy_live_edge_catchup_completed").length, 1);
});

test("audio history trim cannot issue a duplicate fragment credit or reorder init", async () => {
  const sources = []; const buffers = []; const sockets = []; const wire = []; const removed = []; let receive;
  const ranges = { length: 1, start: () => 0, end: () => 19 };
  const video = { currentTime: 10, buffered: ranges, readyState: 4, paused: false, playbackRate: 1.2,
    addEventListener() {}, requestVideoFrameCallback() { return 1; },
    pause() {}, removeAttribute() {}, load() {} };
  class MediaSource {
    static isTypeSupported() { return true; }
    constructor() { this.listeners = {}; this.readyState = "open"; sources.push(this); }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    addSourceBuffer(mime) {
      const buffer = { mime, buffered: mime.startsWith("audio/") ? { length: 0 } : ranges,
        updating: false, listeners: {},
        addEventListener(name, callback) { this.listeners[name] = callback; },
        appendBuffer() {}, remove(start, end) { removed.push([this.mime, start, end]); this.updating = true; } };
      buffers.push(buffer); return buffer;
    }
  }
  class WebSocket {
    constructor() { this.readyState = 1; sockets.push(this); }
    send(value) { wire.push(JSON.parse(value)); }
    close() {}
  }
  const nodes = {};
  const context = { ArrayBuffer, Uint8Array, DataView, TextEncoder, URL,
    performance: { now: () => 100 }, setTimeout: () => 1, clearTimeout() {},
    setInterval: () => 1, clearInterval() {}, MediaSource, WebSocket,
    document: { readyState: "complete", getElementById: (id) => id === "probe-video" ? video : (nodes[id] ||= {}),
      body: { classList: { add() {}, remove() {} } } },
    cast: { framework: { CastReceiverContext: { getInstance: () => ({ addEventListener() {},
      addCustomMessageListener: (_, callback) => { receive = callback; }, start() {}, sendCustomMessage() {} }) },
      CastReceiverOptions: function () {}, system: { EventType: { READY: "ready", SENDER_CONNECTED: "sender_connected" },
        MessageType: { JSON: "JSON" } } } } };
  context.URL = class extends URL { static createObjectURL() { return "blob:test"; } };
  vm.runInNewContext(fs.readFileSync(receiverSourcePath, "utf8"), context);
  sources[0].listeners.sourceopen(); await new Promise(setImmediate);
  receive({ senderId: "sender", data: { type: "startMedia", protocolVersion: 2, requestId: "audio_trim",
    endpoint: "ws://192.168.1.1:1234/" + "a".repeat(64), audioCodec: "mp4a.40.2" } });
  await new Promise(setImmediate);
  sources[1].listeners.sourceopen(); sockets[0].onopen();
  sockets[0].onmessage({ data: JSON.stringify({ type: "readyForMedia", protocolVersion: 2 }) });
  const envelope = (type, sequence) => {
    const bytes = Buffer.alloc(15); bytes.write("SMC1"); bytes[4] = 2; bytes[5] = type;
    bytes.writeUInt32BE(sequence, 6); bytes.writeUInt32BE(1, 10);
    return Uint8Array.from(bytes).buffer;
  };
  const videoBuffer = buffers.filter((buffer) => buffer.mime.startsWith("video/"))[1];
  sockets[0].onmessage({ data: envelope(1, 0) });
  videoBuffer.listeners.updateend();
  assert.equal(video.playbackRate, 1, "negotiated AAC must not remain at fast playback rate");
  const audio = buffers.find((buffer) => buffer.mime === 'audio/mp4; codecs="mp4a.40.2"');
  sockets[0].onmessage({ data: envelope(3, 1) });
  audio.listeners.updateend();
  assert.equal(wire.filter((value) => value.type === "audioCredit").length, 0);
  sockets[0].onmessage({ data: envelope(4, 2) });
  audio.buffered = ranges;
  audio.listeners.updateend();
  assert.deepEqual(removed.filter(([mime]) => mime.startsWith("audio/")),
    [['audio/mp4; codecs="mp4a.40.2"', 0, 7.5]]);
  assert.equal(wire.filter((value) => value.type === "audioCredit").length, 1);
  audio.updating = false; audio.listeners.updateend();
  assert.equal(wire.filter((value) => value.type === "audioCredit").length, 1,
    "remove updateend must not count as an appended fragment");
});
