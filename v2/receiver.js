(function receiverCapabilityGate(global) {
  "use strict";

  const RECEIVER_VERSION = "2.0.0";
  const PROTOCOL_VERSION = 2;
  const NAMESPACE = "urn:x-cast:com.ashwinbhajan.screenmirror.cmafprobe.v2";
  const MIME_TYPE = 'video/mp4; codecs="avc1.42e01f"';
  const MAX_MESSAGE_BYTES = 1024;
  const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;
  const RESULT = Object.freeze({
    CAPABILITY_READY: "capability_ready",
    CAPABILITY_UNSUPPORTED: "capability_unsupported",
    CONNECTED: "websocket_connected",
    MIXED_CONTENT_BLOCKED: "websocket_mixed_content_blocked",
    FAILED: "websocket_failed"
  });

  let context;
  let ui;
  let capabilities = Object.freeze({ webSocketAPI: false, mediaSource: false, avcMIME: false, sourceBuffer: false, autoplay: "timeout" });
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
    // A muted play() promise can remain pending without media bytes. Only an
    // explicit NotAllowedError is an autoplay-policy stop condition; timeout
    // and non-policy errors are reported in the matrix but still permit the
    // independent WebSocket security experiment.
    return capabilities.webSocketAPI && capabilities.mediaSource && capabilities.avcMIME && capabilities.sourceBuffer && capabilities.autoplay !== "blocked"
      ? RESULT.CAPABILITY_READY : RESULT.CAPABILITY_UNSUPPORTED;
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
    const preliminary = capabilityResult();
    if (preliminary !== RESULT.CAPABILITY_READY) { send(senderId, request.requestId, preliminary); update("Unsupported", preliminary); return; }
    let socket;
    let finished = false;
    const complete = (result) => {
      if (finished) return;
      finished = true;
      global.clearTimeout(timeout);
      try { socket && socket.close(); } catch (_) {}
      send(senderId, request.requestId, result);
      update(result === RESULT.CONNECTED ? "Connected" : "Stopped", result);
    };
    try {
      socket = new global.WebSocket(request.endpoint);
      socket.onopen = () => socket.send(JSON.stringify({ type: "hello", token: new URL(request.endpoint).pathname.slice(1) }));
      socket.onmessage = (message) => {
        const acknowledgement = parse(message.data);
        complete(acknowledgement && acknowledgement.type === "ack" && Object.keys(acknowledgement).length === 1 ? RESULT.CONNECTED : RESULT.FAILED);
      };
      socket.onerror = () => complete(global.isSecureContext ? RESULT.MIXED_CONTENT_BLOCKED : RESULT.FAILED);
      socket.onclose = () => { if (!finished) complete(global.isSecureContext ? RESULT.MIXED_CONTENT_BLOCKED : RESULT.FAILED); };
    } catch (_) { complete(global.isSecureContext ? RESULT.MIXED_CONTENT_BLOCKED : RESULT.FAILED); return; }
    const timeout = global.setTimeout(() => complete(global.isSecureContext ? RESULT.MIXED_CONTENT_BLOCKED : RESULT.FAILED), 5000);
  }
  function testCapabilities(video) {
    const result = { webSocketAPI: typeof global.WebSocket === "function", mediaSource: typeof global.MediaSource === "function", avcMIME: false, sourceBuffer: false, autoplay: "timeout" };
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
    const autoplayReady = new Promise((resolve) => {
      try {
        const playing = video.play();
        if (!playing || typeof playing.then !== "function") { resolve("timeout"); return; }
        const timeout = global.setTimeout(() => resolve("timeout"), 1500);
        playing.then(() => { global.clearTimeout(timeout); resolve("allowed"); })
          .catch((error) => { global.clearTimeout(timeout); resolve(error && error.name === "NotAllowedError" ? "blocked" : "non_policy_error"); });
      } catch (error) { resolve(error && error.name === "NotAllowedError" ? "blocked" : "non_policy_error"); }
    });
    return Promise.all([sourceBufferReady, autoplayReady]).then(([sourceBuffer, autoplay]) => {
      capabilities = Object.freeze({ ...result, sourceBuffer, autoplay });
      update(capabilityResult() === RESULT.CAPABILITY_READY ? "Ready" : "Unsupported", "Capability checks completed");
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
