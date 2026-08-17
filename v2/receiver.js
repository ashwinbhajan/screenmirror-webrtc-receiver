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
  function runWebSocketProbe(senderId, request) {
    if (!capabilityResult()) { send(senderId, request.requestId, RESULT.FAILED); update("Unsupported", RESULT.FAILED); return; }
    let socket;
    let finished = false;
    const timeoutRef = { id: null };
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
    context.addCustomMessageListener(NAMESPACE, probeWebSocket);
    const options = new global.cast.framework.CastReceiverOptions();
    options.customNamespaces = { [NAMESPACE]: global.cast.framework.system.MessageType.JSON };
    context.start(options);
    update("Checking", "Testing receiver capabilities before one endpoint probe");
  }
  global.ScreenMirrorReceiverCapabilityGate = Object.freeze({ MIME_TYPE, RESULT, validEndpoint, validateProbe, capabilityResult: () => capabilityResult(), snapshot: () => ({ ...capabilities }) });
  if (typeof document !== "undefined") document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", boot, { once: true }) : boot();
})(globalThis);
