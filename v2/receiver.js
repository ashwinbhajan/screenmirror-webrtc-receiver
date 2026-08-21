(function receiverCapabilityGate(global) {
  "use strict";

  const RECEIVER_VERSION = "2.0.0";
  const PROTOCOL_VERSION = 2;
  const NAMESPACE = "urn:x-cast:com.ashwinbhajan.screenmirror.cmafprobe.v2";
  const MIME_TYPE = 'video/mp4; codecs="avc1.42e01f"';
  const MAX_MESSAGE_BYTES = 1024;
  const RETAINED_HISTORY_SECONDS = 2.5;
  const TRIM_HISTORY_THRESHOLD_SECONDS = 4;
  const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;
  const RESULT = Object.freeze({
    PASS: "capability_pass",
    PARTIAL: "capability_partial",
    FAILED: "capability_failed",
    MIXED_CONTENT_BLOCKED: "websocket_mixed_content_blocked",
    WEBSOCKET_FAILED: "websocket_failed"
  });

  let context;
  let ui;
  let capabilities = Object.freeze({ webSocketAPI: false, mediaSource: false, avcMIME: false, sourceBuffer: false, autoplay: "deferred", websocketAttempted: false, websocketAuthenticated: false, probeAckStatus: "not_attempted", terminalStatus: "capability_partial", websocketLifecycle: "not_attempted" });
  let capabilityReadyPromise = Promise.resolve(capabilities);

  function byteLength(value) { return new TextEncoder().encode(value).length; }
  function safeObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
  function update(state, detail) {
    if (!ui) return;
    ui.state.textContent = state;
    ui.event.textContent = detail;
    ui.detail.textContent = detail;
  }
  function parse(data) {
    try {
      const raw = typeof data === "string" ? data : JSON.stringify(data);
      if (!raw || byteLength(raw) > MAX_MESSAGE_BYTES) return null;
      const object = JSON.parse(raw);
      return safeObject(object) ? object : null;
    } catch (_) { return null; }
  }
  function makeResult(requestId, result) {
    return { type: "probeResult", protocolVersion: PROTOCOL_VERSION, requestId, receiverVersion: RECEIVER_VERSION, result, capabilities: { ...capabilities } };
  }
  function validEndpoint(value) {
    try {
      const url = new URL(value);
      return url.protocol === "ws:" && !!url.hostname && !!url.port && /^\/[A-Za-z0-9]{64}$/.test(url.pathname);
    } catch (_) { return false; }
  }
  function validateProbe(data) {
    const message = parse(data);
    if (!message || Object.keys(message).length !== 4 || message.type !== "probeEndpoint" ||
        message.protocolVersion !== PROTOCOL_VERSION || typeof message.requestId !== "string" ||
        !REQUEST_ID.test(message.requestId) || typeof message.endpoint !== "string" || !validEndpoint(message.endpoint)) return null;
    return message;
  }
  function capabilityResult() {
    return capabilities.webSocketAPI && capabilities.mediaSource && capabilities.avcMIME && capabilities.sourceBuffer;
  }
  function recoverySeekTarget(currentTime, start, end) {
    if (!Number.isFinite(currentTime) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || currentTime >= start) return null;
    return start + Math.min(0.05, Math.max(0, (end - start) / 2));
  }
  function bufferedTrimEnd(currentTime, start, end) {
    if (!Number.isFinite(currentTime) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    if (currentTime - start <= TRIM_HISTORY_THRESHOLD_SECONDS || end - currentTime < 0.5) return null;
    return Math.max(0, currentTime - RETAINED_HISTORY_SECONDS);
  }
  function send(senderId, requestId, result) {
    context.sendCustomMessage(NAMESPACE, senderId, makeResult(requestId, result));
  }
  function probeWebSocket(event) {
    const request = validateProbe(event.data);
    if (!event || !event.senderId || !request) { update("Rejected", "Invalid capability probe command"); return; }
    capabilityReadyPromise.then(() => runWebSocketProbe(event.senderId, request));
  }
  function validateMediaStart(data) {
    const message = parse(data);
    if (!message || Object.keys(message).length !== 4 || message.type !== "startMedia" ||
        message.protocolVersion !== PROTOCOL_VERSION || typeof message.requestId !== "string" ||
        !REQUEST_ID.test(message.requestId) || typeof message.endpoint !== "string" || !validEndpoint(message.endpoint)) return null;
    return message;
  }
  function sendMediaResult(senderId, requestId, result, telemetry) {
    const payload = { type: "mediaResult", protocolVersion: PROTOCOL_VERSION, requestId, receiverVersion: RECEIVER_VERSION, result };
    if (telemetry) payload.telemetry = telemetry;
    context.sendCustomMessage(NAMESPACE, senderId, payload);
  }
  function runMedia(event, request) {
    if (!capabilityResult()) { sendMediaResult(event.senderId, request.requestId, "unsupported"); return; }
    const video = document.getElementById("probe-video");
    document.body.classList.add("media-active");
    update("Media", "Waiting for the first decodable video frame");
    const pending = []; const maxPending = 8;
    let source; let buffer; let socket; let firstKeyframe = false; let firstMediaAppended = false; let lastAppendingType = 0; let firstRendered = false; let playAttempted = false; let initialSeekRequested = false; let initialSeekCompleted = false; let recoverySeekPending = false; let timeUpdated = false; let appendBacklogHighWatermark = 0; let appendedFragments = 0; let initAppendPending = false; let initAppendTimeout; let mediaAppendPending = false; let playTimeout;
    const clearInitAppendTimeout = () => { if (initAppendTimeout) { global.clearTimeout(initAppendTimeout); initAppendTimeout = undefined; } };
    const clearPlayTimeout = () => { if (playTimeout) { global.clearTimeout(playTimeout); playTimeout = undefined; } };
    const stop = (result) => { clearInitAppendTimeout(); clearPlayTimeout(); try { socket && socket.close(); } catch (_) {} sendMediaResult(event.senderId, request.requestId, result); };
    const safePlayRejection = (error) => {
      if (error && error.name === "NotAllowedError") return "play_rejected_not_allowed";
      if (error && error.name === "NotSupportedError") return "play_rejected_not_supported";
      if (error && error.name === "AbortError") return "play_rejected_abort";
      return "play_rejected_other";
    };
    const boundedMs = (value) => Number.isFinite(value) && value >= 0 && value <= 3600 ? Math.round(value * 1000) : null;
    const playbackTelemetry = (checkpoint) => {
      const ranges = video.buffered;
      const hasRange = ranges && ranges.length > 0;
      const durationKind = Number.isNaN(video.duration) ? "nan" : video.duration === Infinity ? "infinite" : Number.isFinite(video.duration) ? "finite" : "unknown";
      sendMediaResult(event.senderId, request.requestId, "playback_state", {
        checkpoint,
        readyState: Math.max(0, Math.min(4, video.readyState || 0)),
        networkState: Math.max(0, Math.min(3, video.networkState || 0)),
        paused: !!video.paused,
        ended: !!video.ended,
        currentTimeMs: boundedMs(video.currentTime) || 0,
        durationKind,
        bufferedLength: Math.max(0, Math.min(8, hasRange ? ranges.length : 0)),
        bufferStartMs: hasRange ? boundedMs(ranges.start(0)) : null,
        bufferEndMs: hasRange ? boundedMs(ranges.end(0)) : null,
        mediaSourceState: source && ["open", "ended", "closed"].includes(source.readyState) ? source.readyState : "unknown",
        sourceBufferUpdating: !!(buffer && buffer.updating),
        appendedFragments,
        keyframeAppended: firstKeyframe && firstMediaAppended,
        queueDepth: Math.max(0, Math.min(8, pending.length))
      });
    };
    const attemptPlay = () => {
      if (playAttempted || !initialSeekCompleted || !firstKeyframe || !firstMediaAppended || !buffer || buffer.updating) return;
      playAttempted = true;
      playbackTelemetry("before_play");
      sendMediaResult(event.senderId, request.requestId, "play_attempt_started");
      let promise;
      try { promise = video.play(); } catch (_) { sendMediaResult(event.senderId, request.requestId, "play_synchronous_exception"); return; }
      sendMediaResult(event.senderId, request.requestId, "play_promise_pending");
      playTimeout = global.setTimeout(() => {
        playbackTelemetry("play_pending_timeout");
        sendMediaResult(event.senderId, request.requestId, "play_pending_timeout");
      }, 5000);
      Promise.resolve(promise).then(() => {
        clearPlayTimeout();
        sendMediaResult(event.senderId, request.requestId, "play_promise_resolved");
      }).catch((error) => {
        clearPlayTimeout();
        sendMediaResult(event.senderId, request.requestId, safePlayRejection(error));
      });
    };
    const ensurePlayablePosition = () => {
      if (initialSeekRequested || !firstKeyframe || !firstMediaAppended || !buffer || buffer.updating || !video.buffered || !video.buffered.length) return;
      const start = video.buffered.start(0);
      const end = video.buffered.end(0);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
      if (video.currentTime >= start && video.currentTime <= end) {
        initialSeekCompleted = true;
        attemptPlay();
        return;
      }
      initialSeekRequested = true;
      const target = start + Math.min(0.05, Math.max(0, (end - start) / 2));
      sendMediaResult(event.senderId, request.requestId, "initial_seek_requested");
      try { video.currentTime = target; } catch (_) { sendMediaResult(event.senderId, request.requestId, "initial_seek_failed"); }
    };
    const recoverPlaybackPosition = () => {
      if (!initialSeekCompleted || recoverySeekPending || !firstRendered || !buffer || buffer.updating || !video.buffered || !video.buffered.length) return;
      const target = recoverySeekTarget(video.currentTime, video.buffered.start(0), video.buffered.end(0));
      if (target === null) return;
      recoverySeekPending = true;
      sendMediaResult(event.senderId, request.requestId, "recovery_seek_requested");
      try { video.currentTime = target; } catch (_) { recoverySeekPending = false; sendMediaResult(event.senderId, request.requestId, "recovery_seek_failed"); }
    };
    const appendNext = () => {
      if (!buffer || buffer.updating || !pending.length) return;
      const item = pending.shift(); lastAppendingType = item.type;
      if (item.type === 1) {
        initAppendPending = true;
        sendMediaResult(event.senderId, request.requestId, `init_append_started_len_${item.payload.byteLength}`);
        initAppendTimeout = global.setTimeout(() => {
          if (initAppendPending) { sendMediaResult(event.senderId, request.requestId, "init_append_timeout"); stop("append_failed"); }
        }, 5000);
      }
      if (item.type === 2) {
        mediaAppendPending = true;
        sendMediaResult(event.senderId, request.requestId, `media_append_started_len_${item.payload.byteLength}`);
      }
      try { buffer.appendBuffer(item.payload); } catch (_) {
        if (item.type === 1) sendMediaResult(event.senderId, request.requestId, "init_append_synchronous_exception");
        if (item.type === 2) sendMediaResult(event.senderId, request.requestId, "media_append_synchronous_exception");
        stop("append_failed");
      }
    };
    const enqueue = (item) => {
      if (pending.length >= maxPending) { pending.splice(0, pending.length - maxPending + 1); }
      pending.push(item); appendBacklogHighWatermark = Math.max(appendBacklogHighWatermark, pending.length); appendNext();
    };
    try {
      source = new global.MediaSource(); video.src = global.URL.createObjectURL(source); video.muted = true; video.playsInline = true;
      source.addEventListener("sourceopen", () => {
        try {
          buffer = source.addSourceBuffer(MIME_TYPE);
          sendMediaResult(event.senderId, request.requestId, "source_buffer_created");
          buffer.addEventListener("updateend", () => {
            if (lastAppendingType === 1 && initAppendPending) {
              initAppendPending = false;
              clearInitAppendTimeout();
              sendMediaResult(event.senderId, request.requestId, "init_append_updateend");
            }
            if (lastAppendingType === 2) firstMediaAppended = true;
            if (lastAppendingType === 2 && mediaAppendPending) {
              mediaAppendPending = false;
              appendedFragments += 1;
              sendMediaResult(event.senderId, request.requestId, "media_append_updateend");
              playbackTelemetry("first_media_append");
            }
            ensurePlayablePosition();
            attemptPlay();
            recoverPlaybackPosition();
            // Preserve a full GOP behind the playhead. Trimming at 0.1 seconds
            // can evict the current decode dependency and force a recovery seek.
            const trimEnd = video.buffered.length ? bufferedTrimEnd(video.currentTime, video.buffered.start(0), video.buffered.end(0)) : null;
            if (trimEnd !== null && typeof buffer.remove === "function" && !buffer.updating) {
              try { buffer.remove(0, trimEnd); } catch (_) {}
            }
            appendNext();
          });
          buffer.addEventListener("error", () => {
            if (lastAppendingType === 1 && initAppendPending) sendMediaResult(event.senderId, request.requestId, "init_append_error_event");
            if (lastAppendingType === 2 && mediaAppendPending) sendMediaResult(event.senderId, request.requestId, "media_append_error_event");
            stop("append_failed");
          });
          buffer.addEventListener("abort", () => {
            if (lastAppendingType === 1 && initAppendPending) sendMediaResult(event.senderId, request.requestId, "init_append_abort_event");
            if (lastAppendingType === 2 && mediaAppendPending) sendMediaResult(event.senderId, request.requestId, "media_append_abort_event");
            stop("append_aborted");
          });
          socket = new global.WebSocket(request.endpoint); socket.binaryType = "arraybuffer";
          socket.onopen = () => socket.send(JSON.stringify({ type: "hello", token: new URL(request.endpoint).pathname.slice(1), protocolVersion: PROTOCOL_VERSION }));
          socket.onmessage = (message) => {
            if (typeof message.data === "string") {
              const control = parse(message.data); if (!control || control.type !== "readyForMedia") { stop("protocol_error"); } return;
            }
            const envelope = parseEnvelope(message.data); if (!envelope) { stop("binary_envelope_invalid"); return; }
            if (envelope.type === 1) { enqueue(envelope); return; }
            if (envelope.type === 2) {
              const summary = summarizeFragment(envelope.payload);
              if (summary) {
                sendMediaResult(event.senderId, request.requestId, `media_fragment_received_len_${envelope.payload.byteLength}`);
                sendMediaResult(event.senderId, request.requestId, `first_fragment_seq_${summary.sequence}_samples_${summary.sampleCount}_tfdt_${summary.decodeTime}_offset_${summary.dataOffset}_payload_${summary.payloadLength}_nal_${summary.firstNALType}`);
              } else {
                sendMediaResult(event.senderId, request.requestId, "media_fragment_layout_invalid");
              }
              firstKeyframe = true; enqueue(envelope); return;
            }
            stop("binary_envelope_invalid");
          };
          socket.onerror = () => stop("websocket_failed"); socket.onclose = () => { if (!firstRendered) sendMediaResult(event.senderId, request.requestId, "websocket_closed"); };
          sendMediaResult(event.senderId, request.requestId, "media_socket_connecting");
        } catch (_) { stop("sourcebuffer_failed"); }
      }, { once: true });
      source.addEventListener("sourceended", () => sendMediaResult(event.senderId, request.requestId, "media_source_state_ended"));
      source.addEventListener("sourceclose", () => sendMediaResult(event.senderId, request.requestId, "media_source_state_closed"));
      video.addEventListener("error", () => sendMediaResult(event.senderId, request.requestId, `media_element_error_code_${video.error ? video.error.code : 0}`));
      video.addEventListener("loadedmetadata", () => sendMediaResult(event.senderId, request.requestId, "media_event_loadedmetadata"));
      video.addEventListener("loadeddata", () => sendMediaResult(event.senderId, request.requestId, "media_event_loadeddata"));
      video.addEventListener("canplay", () => sendMediaResult(event.senderId, request.requestId, "media_event_canplay"));
      video.addEventListener("canplaythrough", () => sendMediaResult(event.senderId, request.requestId, "media_event_canplaythrough"));
      video.addEventListener("waiting", () => sendMediaResult(event.senderId, request.requestId, "media_event_waiting"));
      video.addEventListener("stalled", () => sendMediaResult(event.senderId, request.requestId, "media_event_stalled"));
      video.addEventListener("seeking", () => sendMediaResult(event.senderId, request.requestId, recoverySeekPending ? "recovery_seek_started" : "initial_seek_started"));
      video.addEventListener("seeked", () => {
        if (recoverySeekPending) {
          recoverySeekPending = false;
          sendMediaResult(event.senderId, request.requestId, "recovery_seek_completed");
          try { Promise.resolve(video.play()).catch((error) => sendMediaResult(event.senderId, request.requestId, safePlayRejection(error))); } catch (_) { sendMediaResult(event.senderId, request.requestId, "recovery_play_synchronous_exception"); }
          return;
        }
        if (!initialSeekRequested) return;
        initialSeekCompleted = true;
        playbackTelemetry("before_play");
        sendMediaResult(event.senderId, request.requestId, "initial_seek_completed");
        attemptPlay();
      });
      video.addEventListener("playing", () => {
        sendMediaResult(event.senderId, request.requestId, "media_event_playing");
        if (!firstRendered && firstMediaAppended) {
          firstRendered = true;
          context.sendCustomMessage(NAMESPACE, event.senderId, { type: "firstRenderedFrame", protocolVersion: PROTOCOL_VERSION, requestId: request.requestId, receiverVersion: RECEIVER_VERSION, appendBacklogHighWatermark });
        }
      });
      video.addEventListener("timeupdate", () => {
        if (!timeUpdated) { timeUpdated = true; sendMediaResult(event.senderId, request.requestId, "media_event_timeupdate"); }
      });
    } catch (_) { stop("media_source_failed"); }
  }
  function parseEnvelope(value) {
    if (!(value instanceof ArrayBuffer) || value.byteLength < 14) return null;
    const bytes = new Uint8Array(value); const view = new DataView(value);
    if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "SMC1" || bytes[4] !== 2 || (bytes[5] !== 1 && bytes[5] !== 2)) return null;
    const length = view.getUint32(10); if (length !== bytes.length - 14 || length > 1048576) return null;
    return { type: bytes[5], sequence: view.getUint32(6), payload: value.slice(14) };
  }
  function summarizeFragment(value) {
    if (!(value instanceof ArrayBuffer)) return null;
    const bytes = new Uint8Array(value); const view = new DataView(value);
    const readBoxes = (start, end) => {
      const result = []; for (let offset = start; offset + 8 <= end;) {
        const size = view.getUint32(offset); if (size < 8 || offset + size > end) return null;
        result.push({ offset, size, type: String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]) }); offset += size;
      } return result;
    };
    const top = readBoxes(0, bytes.length); if (!top) return null;
    const moof = top.find((box) => box.type === "moof"); const mdat = top.find((box) => box.type === "mdat");
    if (!moof || !mdat) return null;
    const moofChildren = readBoxes(moof.offset + 8, moof.offset + moof.size); if (!moofChildren) return null;
    const mfhd = moofChildren.find((box) => box.type === "mfhd"); const traf = moofChildren.find((box) => box.type === "traf"); if (!mfhd || !traf) return null;
    const trafChildren = readBoxes(traf.offset + 8, traf.offset + traf.size); if (!trafChildren) return null;
    const tfdt = trafChildren.find((box) => box.type === "tfdt"); const trun = trafChildren.find((box) => box.type === "trun"); if (!tfdt || !trun || trun.size < 20) return null;
    const version = bytes[tfdt.offset + 8]; const decodeTime = version === 1 ? Number(view.getBigUint64(tfdt.offset + 12)) : view.getUint32(tfdt.offset + 12);
    const dataOffset = view.getUint32(trun.offset + 16); const payloadStart = moof.offset + dataOffset;
    if (payloadStart < mdat.offset + 8 || payloadStart + 5 > mdat.offset + mdat.size) return null;
    const nalLength = view.getUint32(payloadStart); if (nalLength === 0 || payloadStart + 4 + nalLength > mdat.offset + mdat.size) return null;
    return { sequence: view.getUint32(mfhd.offset + 12), sampleCount: view.getUint32(trun.offset + 12), decodeTime, dataOffset, payloadLength: mdat.size - 8, firstNALType: bytes[payloadStart + 4] & 0x1f };
  }
  function bufferedLead(video) {
    for (let i = 0; i < video.buffered.length; i += 1) if (video.currentTime >= video.buffered.start(i) && video.currentTime <= video.buffered.end(i)) return video.buffered.end(i) - video.currentTime;
    return 0;
  }
  function receiverMessage(event) {
    const probe = event && validateProbe(event.data); if (probe) { capabilityReadyPromise.then(() => runWebSocketProbe(event.senderId, probe)); return; }
    const media = event && validateMediaStart(event.data); if (media) { capabilityReadyPromise.then(() => runMedia(event, media)); return; }
    update("Rejected", "Invalid v2 command");
  }
  function runWebSocketProbe(senderId, request) {
    if (!capabilityResult()) { send(senderId, request.requestId, RESULT.FAILED); update("Unsupported", RESULT.FAILED); return; }
    let socket;
    let finished = false;
    let timeoutRef = { id: null };
    const complete = (result, terminalStatus, probeAckStatus) => {
      if (finished) return;
      finished = true;
      if (timeoutRef.id !== null) global.clearTimeout(timeoutRef.id);
      try { socket && socket.close(); } catch (_) {}
      capabilities = Object.freeze({ ...capabilities, probeAckStatus, terminalStatus });
      send(senderId, request.requestId, result);
      update(result === RESULT.PASS ? "Passed" : "Stopped", result);
    };
    let opened = false;
    try {
      socket = new global.WebSocket(request.endpoint);
      socket.onopen = () => {
        opened = true;
        capabilities = Object.freeze({ ...capabilities, websocketAttempted: true, websocketLifecycle: "opened" });
        socket.send(JSON.stringify({ type: "hello", token: new URL(request.endpoint).pathname.slice(1) }));
      };
      socket.onmessage = (message) => {
        const acknowledgement = parse(message.data);
        if (acknowledgement && acknowledgement.type === "ack" && Object.keys(acknowledgement).length === 1) {
          capabilities = Object.freeze({ ...capabilities, websocketAuthenticated: true, websocketLifecycle: "ack_received" });
          socket.send(JSON.stringify({ type: "confirmed" }));
          global.setTimeout(() => complete(RESULT.PASS, "capability_pass", "confirmed"), 50);
        } else {
          complete(RESULT.FAILED, "capability_failed", "rejected");
        }
      };
      socket.onerror = () => {
        if (capabilities.websocketAuthenticated) {
          complete(RESULT.PASS, "capability_pass", "confirmed");
          return;
        }
        capabilities = Object.freeze({ ...capabilities, websocketLifecycle: opened ? "error_after_open" : "error_before_open" });
        complete(RESULT.WEBSOCKET_FAILED, "capability_failed", "transport_error");
      };
      socket.onclose = () => {
        if (!finished) {
          if (capabilities.websocketAuthenticated) {
            complete(RESULT.PASS, "capability_pass", "confirmed");
            return;
          }
          capabilities = Object.freeze({ ...capabilities, websocketLifecycle: opened ? "closed_before_auth" : "error_before_open" });
          complete(RESULT.WEBSOCKET_FAILED, "capability_failed", "transport_error");
        }
      };
    } catch (error) {
      const securityRejected = error && error.name === "SecurityError";
      capabilities = Object.freeze({ ...capabilities, websocketLifecycle: securityRejected ? "constructor_security_rejected" : "error_before_open" });
      complete(securityRejected ? RESULT.MIXED_CONTENT_BLOCKED : RESULT.WEBSOCKET_FAILED, "capability_failed", "transport_error");
      return;
    }
    timeoutRef.id = global.setTimeout(() => {
      capabilities = Object.freeze({ ...capabilities, websocketLifecycle: "transport_timeout" });
      complete(RESULT.WEBSOCKET_FAILED, "capability_failed", "transport_error");
    }, 5000);
  }
  function testCapabilities(video) {
    const result = { webSocketAPI: typeof global.WebSocket === "function", mediaSource: typeof global.MediaSource === "function", avcMIME: false, sourceBuffer: false, autoplay: "deferred", websocketAttempted: false, websocketAuthenticated: false, probeAckStatus: "not_attempted", terminalStatus: "capability_partial", websocketLifecycle: "not_attempted" };
    result.avcMIME = result.mediaSource && global.MediaSource.isTypeSupported(MIME_TYPE) === true;
    const sourceBufferReady = new Promise((resolve) => {
      if (!result.avcMIME) { resolve(false); return; }
      try {
        const source = new global.MediaSource();
        video.src = global.URL.createObjectURL(source);
        const timeout = global.setTimeout(() => resolve(false), 1500);
        source.addEventListener("sourceopen", () => {
          global.clearTimeout(timeout);
          try { resolve(!!source.addSourceBuffer(MIME_TYPE)); } catch (_) { resolve(false); }
        }, { once: true });
      } catch (_) { resolve(false); }
    });
    return sourceBufferReady.then((sourceBuffer) => {
      capabilities = Object.freeze({ ...result, sourceBuffer });
      update(capabilityResult() ? "Ready" : "Unsupported", "Autoplay deferred until decodable media");
      return capabilities;
    });
  }
  function boot() {
    ui = { state: document.getElementById("connection-state"), event: document.getElementById("last-event"), detail: document.getElementById("status-detail"), version: document.getElementById("receiver-version") };
    ui.version.textContent = RECEIVER_VERSION;
    const video = document.getElementById("probe-video");
    capabilityReadyPromise = testCapabilities(video);
    if (!global.cast || !global.cast.framework) { update("Error", "CAF unavailable"); return; }
    context = global.cast.framework.CastReceiverContext.getInstance();
    context.addCustomMessageListener(NAMESPACE, receiverMessage);
    const options = new global.cast.framework.CastReceiverOptions();
    options.customNamespaces = { [NAMESPACE]: global.cast.framework.system.MessageType.JSON };
    context.start(options);
    update("Checking", "Testing receiver capabilities before one endpoint probe");
  }
  global.ScreenMirrorReceiverCapabilityGate = Object.freeze({ MIME_TYPE, RESULT, validEndpoint, validateProbe, recoverySeekTarget, bufferedTrimEnd, capabilityResult: () => capabilityResult(), snapshot: () => ({ ...capabilities }) });
  if (typeof document !== "undefined") document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", boot, { once: true }) : boot();
})(globalThis);
