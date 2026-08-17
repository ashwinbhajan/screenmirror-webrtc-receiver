(function receiverCapabilityGate(global) {
  "use strict";

  const RECEIVER_VERSION = "2.0.0";
  const PROTOCOL_VERSION = 2;
  const NAMESPACE = "urn:x-cast:com.ashwinbhajan.screenmirror.cmafprobe.v2";
  const MIME_TYPE = 'video/mp4; codecs="avc1.42e01f"';
  const MAX_MESSAGE_BYTES = 1024;
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
  function sendMediaResult(senderId, requestId, result) {
    context.sendCustomMessage(NAMESPACE, senderId, { type: "mediaResult", protocolVersion: PROTOCOL_VERSION, requestId, receiverVersion: RECEIVER_VERSION, result });
  }
  function runMedia(event, request) {
    if (!capabilityResult()) { sendMediaResult(event.senderId, request.requestId, "unsupported"); return; }
    const video = document.getElementById("probe-video");
    const pending = []; const maxPending = 8;
    let source; let buffer; let socket; let firstKeyframe = false; let firstMediaAppended = false; let lastAppendingType = 0; let firstRendered = false; let appendBacklogHighWatermark = 0; let initAppendPending = false; let initAppendTimeout;
    const clearInitAppendTimeout = () => { if (initAppendTimeout) { global.clearTimeout(initAppendTimeout); initAppendTimeout = undefined; } };
    const stop = (result) => { clearInitAppendTimeout(); try { socket && socket.close(); } catch (_) {} sendMediaResult(event.senderId, request.requestId, result); };
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
      try { buffer.appendBuffer(item.payload); } catch (_) {
        if (item.type === 1) sendMediaResult(event.senderId, request.requestId, "init_append_synchronous_exception");
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
            if (firstKeyframe && firstMediaAppended && !firstRendered) {
              firstRendered = true;
              Promise.resolve(video.play()).then(() => {
                sendMediaResult(event.senderId, request.requestId, "autoplay_started");
                context.sendCustomMessage(NAMESPACE, event.senderId, { type: "firstRenderedFrame", protocolVersion: PROTOCOL_VERSION, requestId: request.requestId, receiverVersion: RECEIVER_VERSION, appendBacklogHighWatermark });
              }).catch((error) => sendMediaResult(event.senderId, request.requestId, error && error.name === "NotAllowedError" ? "autoplay_blocked" : "autoplay_failed"));
            }
            // Keep the live edge bounded without accumulating an HLS-like buffer.
            if (bufferedLead(video) > 1.5 && typeof buffer.remove === "function" && !buffer.updating) {
              try { buffer.remove(0, Math.max(0, video.currentTime - 0.1)); } catch (_) {}
            }
            appendNext();
          });
          buffer.addEventListener("error", () => {
            if (lastAppendingType === 1 && initAppendPending) sendMediaResult(event.senderId, request.requestId, "init_append_error_event");
            stop("append_failed");
          });
          buffer.addEventListener("abort", () => {
            if (lastAppendingType === 1 && initAppendPending) sendMediaResult(event.senderId, request.requestId, "init_append_abort_event");
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
            if (envelope.type === 2) { firstKeyframe = true; enqueue(envelope); return; }
            stop("binary_envelope_invalid");
          };
          socket.onerror = () => stop("websocket_failed"); socket.onclose = () => { if (!firstRendered) sendMediaResult(event.senderId, request.requestId, "websocket_closed"); };
          sendMediaResult(event.senderId, request.requestId, "media_socket_connecting");
        } catch (_) { stop("sourcebuffer_failed"); }
      }, { once: true });
      source.addEventListener("sourceended", () => sendMediaResult(event.senderId, request.requestId, "media_source_state_ended"));
      source.addEventListener("sourceclose", () => sendMediaResult(event.senderId, request.requestId, "media_source_state_closed"));
      video.addEventListener("error", () => sendMediaResult(event.senderId, request.requestId, `media_element_error_code_${video.error ? video.error.code : 0}`));
    } catch (_) { stop("media_source_failed"); }
  }
  function parseEnvelope(value) {
    if (!(value instanceof ArrayBuffer) || value.byteLength < 14) return null;
    const bytes = new Uint8Array(value); const view = new DataView(value);
    if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "SMC1" || bytes[4] !== 2 || (bytes[5] !== 1 && bytes[5] !== 2)) return null;
    const length = view.getUint32(10); if (length !== bytes.length - 14 || length > 1048576) return null;
    return { type: bytes[5], sequence: view.getUint32(6), payload: value.slice(14) };
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
  global.ScreenMirrorReceiverCapabilityGate = Object.freeze({ MIME_TYPE, RESULT, validEndpoint, validateProbe, capabilityResult: () => capabilityResult(), snapshot: () => ({ ...capabilities }) });
  if (typeof document !== "undefined") document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", boot, { once: true }) : boot();
})(globalThis);
