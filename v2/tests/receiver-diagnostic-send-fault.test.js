// Test-only extension of the existing receiver VM/event harness pattern.
// Execute immutable approved bytes; never patch/instrument the production source.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const test = require('node:test');
const sourcePath = process.env.SCREENMIRROR_RECEIVER_PATH || path.resolve(__dirname, '../../../../docs/implementation/video-presets-20261017/caf-idle-observability/candidate/v2/receiver.js');
const isolated = process.env.SCREENMIRROR_EXPECT_ISOLATED === '1';
const source = fs.readFileSync(sourcePath, 'utf8');
assert.equal(crypto.createHash('sha256').update(source).digest('hex'),
  process.env.SCREENMIRROR_RECEIVER_SHA256 || '66b53e6d9934ae1a47105e077ca02eb9130e16ad85d967c31e5c23d3a15856c8');
const observations = [];
const normalTraces = [];
const flush = () => new Promise(setImmediate);

// Same moof/traf/mdat and SMC1 builders as the existing live-event VM tests.
function fragment(sequence, time = 1) {
  const box = (name, body) => { const b = Buffer.alloc(8 + body.length); b.writeUInt32BE(b.length); b.write(name, 4); body.copy(b, 8); return b; };
  const mfhd = Buffer.alloc(8); mfhd.writeUInt32BE(sequence, 4);
  const tfdt = Buffer.alloc(12); tfdt[0] = 1; tfdt.writeBigUInt64BE(BigInt(Math.round(time * 90000)), 4);
  const trun = Buffer.alloc(24); trun.writeUIntBE(0x000701, 1, 3); trun.writeUInt32BE(1, 4);
  trun.writeUInt32BE(9000, 12); trun.writeUInt32BE(5, 16); trun.writeUInt32BE(0x02000000, 20);
  const moof = () => box('moof', Buffer.concat([box('mfhd', mfhd), box('traf', Buffer.concat([box('tfdt', tfdt), box('trun', trun)]))]));
  trun.writeUInt32BE(moof().length + 8, 8);
  return Buffer.concat([moof(), box('mdat', Buffer.from([0, 0, 0, 1, 0x65]))]);
}
async function harness() {
  const sources = [], buffers = [], sockets = [], wire = [], attempts = [], delivered = [], payloads = [], exceptions = [], seeks = [], cleanup = [], consoleRecords = [];
  const nodes = {}, events = {}, timers = new Map(), frames = new Map();
  let receive, now = 0, timerID = 0, frameID = 0, fault = null, faultHits = 0, persistentFault = false, consoleFault = false, consoleThrows = 0, currentTime = 1;
  const ranges = { length: 1, start: () => 0, end: () => 3 };
  const video = { buffered: ranges, readyState: 4, paused: false, ended: false, seeking: false, playbackRate: 1,
    get currentTime() { return currentTime; }, set currentTime(t) { seeks.push(t); currentTime = t; },
    addEventListener(name, cb) { events[name] = cb; },
    requestVideoFrameCallback(cb) { frames.set(++frameID, cb); return frameID; },
    cancelVideoFrameCallback(id) { frames.delete(id); },
    play() { return Promise.resolve(); }, pause() { cleanup.push('pause'); }, removeAttribute() { cleanup.push('src'); }, load() { cleanup.push('load'); } };
  class MediaSource {
    static isTypeSupported() { return true; }
    constructor() { this.readyState = 'open'; this.listeners = {}; sources.push(this); }
    addEventListener(name, cb) { this.listeners[name] = cb; }
    addSourceBuffer(mime) {
      const b = { mime, buffered: ranges, updating: false, listeners: {}, appends: 0,
        addEventListener(name, cb) { this.listeners[name] = cb; },
        appendBuffer(payload) { if (this.failAppend) throw new Error('fixture_real_append_error'); assert.equal(this.updating, false); this.updating = true; this.appends++; (this.labels ||= []).push(new Uint8Array(payload)[0]); },
        remove() {}, };
      buffers.push(b); return b;
    }
    removeSourceBuffer(b) { b.removed = true; }
  }
  class WebSocket {
    constructor() { this.readyState = 1; this.closes = []; sockets.push(this); }
    send(value) { wire.push(JSON.parse(value)); }
    close(code, reason) { this.closes.push({ code, reason }); this.readyState = 3; }
  }
  const context = { ArrayBuffer, Uint8Array, DataView, TextEncoder, URL: class extends URL { static createObjectURL() { return 'blob:fixture'; } },
    performance: { now: () => now }, setTimeout(cb) { timers.set(++timerID, cb); return timerID; }, clearTimeout(id) { timers.delete(id); },
    console: { info(_, value) { if (consoleFault) { consoleThrows++; throw new Error('injected_console_send'); } consoleRecords.push(value); } }, MediaSource, WebSocket,
    document: { readyState: 'complete', getElementById: id => id === 'probe-video' ? video : (nodes[id] ||= {}), body: { classList: { add() {}, remove() {} } } },
    cast: { framework: { CastReceiverContext: { getInstance: () => ({ addEventListener() {},
      addCustomMessageListener(_, cb) { receive = cb; }, start() {},
      sendCustomMessage(_, __, value) {
        attempts.push(value.result);
        if (fault && (fault === '*' || (value.result && value.result.startsWith(fault)))) { faultHits++; if (!persistentFault) fault = null; throw new Error('injected_optional_cast_send'); }
        delivered.push(value.result); payloads.push(JSON.parse(JSON.stringify(value)));
      } }) }, CastReceiverOptions: function () {}, system: { EventType: { READY: 'ready', SENDER_CONNECTED: 'sender_connected' }, MessageType: { JSON: 'JSON' } } } } };
  vm.runInNewContext(source, context, { filename: sourcePath });
  sources[0].listeners.sourceopen(); await flush();
  receive({ senderId: 'fixture-sender', data: { type: 'startMedia', protocolVersion: 2, requestId: 'fixture_request',
    endpoint: 'ws://192.168.1.1:1234/' + 'a'.repeat(64), audioCodec: 'mp4a.40.2' } });
  await flush(); sources[1].listeners.sourceopen(); sockets[0].onopen();
  function control(value) { sockets[0].onmessage({ data: JSON.stringify(value) }); }
  control({ type: 'readyForMedia', protocolVersion: 2 });
  const v = buffers.filter(b => b.mime.startsWith('video/'))[1], a = buffers.find(b => b.mime.startsWith('audio/'));
  function send(type, seq, payload = Buffer.from([1])) {
    const b = Buffer.alloc(14 + payload.length); b.write('SMC1'); b[4] = 2; b[5] = type;
    b.writeUInt32BE(seq, 6); b.writeUInt32BE(payload.length, 10); payload.copy(b, 14);
    sockets[0].onmessage({ data: Uint8Array.from(b).buffer });
  }
  function complete(b) { b.updating = false; b.listeners.updateend(); }
  send(1, 0); complete(v); send(3, 0); complete(a); await flush();
  return { video, v, a, wire, attempts, delivered, payloads, frames, seeks, cleanup, consoleRecords, sockets, events, send, control, complete,
    at(value) { now = value; }, armConsole() { consoleFault = true; }, arm(value, persistent = false) { fault = value; persistentFault = persistent; }, get faultHits() { return faultHits; },
    invoke(cb) { try { cb(); } catch (e) { assert.match(e.message, /injected_optional_cast_send/); exceptions.push(e.message); } },
    frame(time = currentTime) { const id = Math.min(...frames.keys()), cb = frames.get(id); assert.ok(cb, 'one scheduled rVFC is consumed'); frames.delete(id); cb(now, { mediaTime: time, presentedFrames: frameID, expectedDisplayTime: now + 16 }); },
    async playing() { send(2, 1, fragment(1)); complete(v); await flush(); this.frame(); },
    snapshot() { return { videoAppends: v.appends, audioAppends: a.appends, audioRemoved: !!a.removed, audioAppendLabels: [...(a.labels || [])],
      mediaCredits: wire.filter(x => x.type === 'mediaCredit').length, audioCredits: wire.filter(x => x.type === 'audioCredit').length,
      renderedFrames: wire.filter(x => x.type === 'renderedFrame').length, scheduledFrames: frames.size, seeks: [...seeks],
      cleanup: [...cleanup], title: nodes['status-title'].textContent, closes: sockets[0].closes.length,
      consoleThrows, audioDegraded: delivered.includes('audio_append_failed_video_continues'), stopScreenAck: delivered.includes('receiver_casting_stopped_screen_shown'), uncaughtExceptions: exceptions.length, injectedThrows: faultHits }; } };
}
async function compare(name, scenario, check) {
  const values = [];
  for (const faulted of [false, true]) { const h = await harness(); await scenario(h, faulted); if (!faulted) normalTraces.push({ name, payloads: h.payloads, wire: h.wire.filter(x => x.type !== 'hello') }); if (faulted) assert.equal(h.faultHits, 1, 'target reached exactly once'); values.push(h.snapshot()); }
  if (isolated) {
    const normalized = value => { const copy = { ...value }; delete copy.injectedThrows; delete copy.consoleThrows;
      if (name === 'stop-receiver_casting_stopped_screen_shown') delete copy.stopScreenAck;
      return copy; };
    assert.deepEqual(normalized(values[1]), normalized(values[0]), 'optional failure preserves all critical operations and state');
    assert.equal(values[1].uncaughtExceptions, 0);
    if (name === 'stop-receiver_casting_stopped_screen_shown') assert.equal(values[1].stopScreenAck, false, 'failed required send is never successful proof');
  } else check(...values);
  observations.push({ name, normal: values[0], faulted: values[1] });
}

test('audio updateend diagnostic before credit and next queued append interrupts both', async () => {
  await compare('audio-before-pump-and-credit', async (h, faulted) => {
    h.send(4, 1); h.send(4, 2); if (faulted) h.arm('audio_fragment_append_updateend');
    h.invoke(() => h.complete(h.a));
  }, (n, f) => { assert.equal(n.audioAppends, 3); assert.equal(f.audioAppends, 2); assert.equal(n.audioCredits, 1); assert.equal(f.audioCredits, 0); assert.equal(f.uncaughtExceptions, 1); });
});
test('audio ordinary append diagnostic is AFTER append and exception falsely degrades audio', async () => {
  await compare('audio-post-append', async (h, faulted) => {
    if (faulted) h.arm('audio_fragment_append_started'); h.invoke(() => h.send(4, 1));
    h.complete(h.a); h.send(4, 2);
  }, (n, f) => { assert.equal(n.audioAppends, 3); assert.equal(f.audioAppends, 2); assert.equal(n.audioDegraded, false); assert.equal(f.audioDegraded, true); assert.equal(f.audioRemoved, false); assert.equal(n.audioCredits, 1); assert.equal(f.audioCredits, 0); assert.equal(f.uncaughtExceptions, 0); });
});
test('audio overflow diagnostic before enqueue prevents incoming audio append', async () => {
  await compare('audio-before-enqueue', async (h, faulted) => {
    for (let seq = 1; seq <= 5; seq++) h.send(4, seq, Buffer.from([seq]));
    if (faulted) h.arm('audio_queue_evicted');
    h.invoke(() => h.send(4, 6, Buffer.from([6])));
    while (h.a.updating) h.complete(h.a);
  }, (n, f) => {
    assert.deepEqual(n.audioAppendLabels, [1, 1, 3, 4, 5, 6]);
    assert.deepEqual(f.audioAppendLabels, [1, 1, 3, 4, 5]);
    assert.equal(n.audioCredits, 5); assert.equal(f.audioCredits, 4); assert.equal(f.uncaughtExceptions, 1);
  });
});
test('video diagnostic before append prevents appendBuffer', async () => {
  await compare('video-before-append', async (h, faulted) => {
    if (faulted) h.arm('media_append_started_len_'); h.invoke(() => h.send(2, 1, fragment(1)));
  }, (n, f) => { assert.equal(n.videoAppends, 2); assert.equal(f.videoAppends, 1); assert.equal(f.uncaughtExceptions, 1); });
});
test('video updateend diagnostic prevents credit and next queued append', async () => {
  await compare('video-before-credit-and-pump', async (h, faulted) => {
    h.send(2, 1, fragment(1)); h.send(2, 2, fragment(2, 1.1));
    if (faulted) h.arm('media_append_updateend'); h.invoke(() => h.complete(h.v));
  }, (n, f) => { assert.equal(n.videoAppends, 3); assert.equal(f.videoAppends, 2); assert.equal(n.mediaCredits, 1); assert.equal(f.mediaCredits, 0); assert.equal(f.uncaughtExceptions, 1); });
});
test('optional correlation expiry diagnostic interrupts frame reporting and rVFC rescheduling', async () => {
  await compare('frame-before-feedback', async (h, faulted) => {
    await h.playing(); h.at(9500); h.video.currentTime = 2; h.events.timeupdate(); h.seeks.length = 0;
    h.control({ type: 'frameCorrelation', generation: 1, sequence: 2, fragmentSequence: 2, mediaTimeMs: 2000 });
    h.send(2, 2, fragment(2, 2)); h.complete(h.v); h.at(11000);
    if (faulted) h.arm('frame_correlation_late_bind_expired'); h.invoke(() => h.frame(2));
  }, (n, f) => { assert.equal(n.renderedFrames, 1); assert.equal(f.renderedFrames, 0); assert.equal(n.scheduledFrames, 1); assert.equal(f.scheduledFrames, 0); assert.equal(f.uncaughtExceptions, 1); });
});
test('recovery diagnostic strands pending state before any seek and prevents later recovery', async () => {
  await compare('recovery-pending', async (h, faulted) => {
    h.video.currentTime = -1; await h.playing(); h.events.seeked(); h.seeks.length = 0; h.video.buffered = { length: 1, start: () => 5, end: () => 8 };
    h.send(2, 2, fragment(2, 5)); if (faulted) h.arm('receiver_live_edge_recovery_seek'); h.invoke(() => h.complete(h.v));
    // Remove the injection, change the target again, and trigger a fresh updateend.
    // A healthy receiver can complete its real seek; a faulted one has no seek to finish.
    if (h.seeks.length) h.events.seeked();
    h.video.buffered = { length: 1, start: () => 10, end: () => 13 };
    h.send(2, 3, fragment(3, 10)); h.complete(h.v);
    // Observe the private pending guard through its existing event disposition.
    h.events.seeking();
    assert.ok(h.delivered.includes('recovery_seek_started'));
  }, (n, f) => { assert.equal(n.seeks.length, 2); assert.equal(f.seeks.length, 0); assert.equal(f.uncaughtExceptions, 1); });
});
for (const marker of ['receiver_stop_received', 'frame_pacing_summary_', 'receiver_video_cleared', 'receiver_idle_screen_shown', 'receiver_casting_stopped_screen_shown']) {
  test(`Stop fault at ${marker} versus normal native Stop`, async () => {
    await compare(`stop-${marker}`, async (h, faulted) => {
      h.control({ type: 'frameCorrelation', generation: 1, sequence: 1, mediaTimeMs: 1000 }); await h.playing();
      if (faulted) h.arm(marker);
      h.invoke(() => h.control({ type: 'normalStop', protocolVersion: 2 }));
      if (isolated) {
        for (const result of ['receiver_stop_received', 'receiver_video_cleared', 'receiver_idle_screen_shown', 'receiver_casting_stopped_screen_shown']) {
          assert.equal(h.attempts.filter(x => x === result).length, 1);
          if (faulted && marker === result) {
            assert.ok(h.consoleRecords.some(x => x.stage === 'dispatch_threw' && x.result === result));
            assert.ok(!h.consoleRecords.some(x => x.stage === 'dispatch_returned' && x.result === result));
          }
        }
      }
    }, (n, f) => {
      assert.equal(n.stopScreenAck, true); assert.equal(n.title, 'Casting Stopped'); assert.equal(n.closes, 1);
      assert.equal(f.stopScreenAck, false); assert.equal(f.closes, 0); assert.equal(f.uncaughtExceptions, 1);
      assert.equal(f.cleanup.length, ['receiver_video_cleared', 'receiver_idle_screen_shown', 'receiver_casting_stopped_screen_shown'].includes(marker) ? 3 : 0);
    });
  });
}
test('Stop console diagnostics are already isolated from exceptions', async () => {
  const values = [];
  for (const faulted of [false, true]) {
    const h = await harness(); if (faulted) h.armConsole();
    h.invoke(() => h.control({ type: 'normalStop', protocolVersion: 2 })); values.push(h.snapshot());
  }
  for (const v of values) { assert.equal(v.stopScreenAck, true); assert.equal(v.closes, 1); assert.equal(v.cleanup.length, 3); assert.equal(v.uncaughtExceptions, 0); }
  assert.equal(values[0].consoleThrows, 0); assert.ok(values[1].consoleThrows > 0);
  observations.push({ name: 'stop-console-throw', normal: values[0], faulted: values[1] });
});
// Negative controls: isolation must not disguise real operation/proof failures.
for (const track of ['audio', 'video']) test(`real ${track} append errors still take existing failure path`, { skip: !isolated }, async () => {
  const h = await harness();
  (track === 'audio' ? h.a : h.v).failAppend = true;
  h.invoke(() => h.send(track === 'audio' ? 4 : 2, 1, track === 'audio' ? Buffer.from([1]) : fragment(1)));
  if (track === 'audio') {
    assert.ok(h.delivered.includes('audio_append_failed_video_continues')); assert.equal(h.snapshot().audioCredits, 0);
    assert.equal(h.a.appends, 1); assert.equal(h.a.removed, true); assert.equal(h.sockets[0].closes.length, 0);
  } else {
    assert.ok(h.delivered.includes('append_failed')); assert.equal(h.snapshot().mediaCredits, 0);
    assert.equal(h.v.appends, 1); assert.equal(h.sockets[0].closes.length, 1);
  }
});
test('required first-frame proof send failure is not treated as an optional diagnostic', { skip: !isolated }, async () => {
  const h = await harness(); h.send(2, 1, fragment(1)); h.complete(h.v);
  h.arm('first_frame_callback_presented_'); h.invoke(() => h.frame());
  assert.equal(h.faultHits, 1); assert.equal(h.snapshot().uncaughtExceptions, 1);
  assert.ok(!h.delivered.some(x => x && x.startsWith('first_frame_callback_presented_')));
  assert.ok(!h.payloads.some(x => x.type === 'firstRenderedFrame'));
});
test('persistent unavailable Cast channel cannot prevent native Stop cleanup or proof attempts', { skip: !isolated }, async () => {
  const h = await harness(); h.control({ type: 'frameCorrelation', generation: 1, sequence: 1, mediaTimeMs: 1000 }); await h.playing();
  h.arm('*', true); h.invoke(() => h.control({ type: 'normalStop', protocolVersion: 2 }));
  const state = h.snapshot(); assert.equal(state.uncaughtExceptions, 0); assert.equal(state.cleanup.length, 3);
  assert.equal(state.scheduledFrames, 0); assert.equal(state.closes, 1); assert.equal(state.stopScreenAck, false); assert.equal(state.title, 'Casting Stopped');
  for (const result of ['receiver_stop_received', 'receiver_video_cleared', 'receiver_idle_screen_shown', 'receiver_casting_stopped_screen_shown']) {
    assert.equal(h.attempts.filter(x => x === result).length, 1); assert.ok(!h.delivered.includes(result));
    assert.ok(h.consoleRecords.some(x => x.stage === 'dispatch_threw' && x.result === result));
  }
});
test('Stop cancels late frame callbacks and credits without duplicate cleanup', { skip: !isolated }, async () => {
  const h = await harness(); await h.playing(); const lateFrame = [...h.frames.values()][0];
  h.arm('frame_pacing_summary_'); h.control({ type: 'normalStop', protocolVersion: 2 }); const before = h.snapshot();
  lateFrame(500, { mediaTime: 1, presentedFrames: 10 }); h.complete(h.v); h.complete(h.a);
  h.sockets[0].onclose({ code: 1000, wasClean: true }); h.sockets[0].onclose({ code: 1000, wasClean: true });
  assert.deepEqual(h.snapshot(), before);
});
test.after(() => {
  if (process.env.SCREENMIRROR_FAULT_RESULTS) fs.writeFileSync(process.env.SCREENMIRROR_FAULT_RESULTS, JSON.stringify({ sourceSHA256: crypto.createHash('sha256').update(source).digest('hex'), observations, normalTraces }, null, 2) + '\n');
});
