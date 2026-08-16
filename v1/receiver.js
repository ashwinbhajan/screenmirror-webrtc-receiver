(function receiverBootstrap(global) {
  "use strict";

  const RECEIVER_VERSION = "1.0.0";
  const PROTOCOL_VERSION = 1;
  const NAMESPACE = "urn:x-cast:com.ashwinbhajan.screenmirror.webrtc.v1";
  const MAX_MESSAGE_BYTES = 1024;
  const MAX_REQUEST_ID_LENGTH = 64;
  const MAX_TIMESTAMP_MS = 9_999_999_999_999;
  const MAX_EVENT_HISTORY = 24;
  const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

  const telemetry = {
    received: 0,
    acknowledged: 0,
    rejected: 0,
    failures: 0,
    events: []
  };

  let ui;
  let receiverContext;

  function byteLength(value) {
    return new TextEncoder().encode(value).length;
  }

  function isPlainObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function invalid(code) {
    return { ok: false, code };
  }

  function decodeMessage(data) {
    let serialized;
    let decoded = data;

    try {
      if (typeof data === "string") {
        serialized = data;
        if (byteLength(serialized) > MAX_MESSAGE_BYTES) {
          return invalid("message_too_large");
        }
        decoded = JSON.parse(serialized);
      } else {
        serialized = JSON.stringify(data);
        if (typeof serialized !== "string" || byteLength(serialized) > MAX_MESSAGE_BYTES) {
          return invalid("message_too_large");
        }
        // Normalize object input through JSON so the validation boundary is
        // identical for Cast runtime data and JSON strings.
        decoded = JSON.parse(serialized);
      }
    } catch (_) {
      return invalid("malformed_json");
    }

    return isPlainObject(decoded) ? { ok: true, value: decoded } : invalid("message_not_object");
  }

  function validatePing(data) {
    const decoded = decodeMessage(data);
    if (!decoded.ok) {
      return decoded;
    }

    const message = decoded.value;
    const allowedFields = new Set(["type", "protocolVersion", "requestId", "timestampMs"]);
    if (Object.keys(message).some((key) => !allowedFields.has(key))) {
      return invalid("unexpected_field");
    }
    if (message.type !== "ping") {
      return invalid("unsupported_message_type");
    }
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      return invalid("unsupported_protocol_version");
    }
    if (
      typeof message.requestId !== "string" ||
      message.requestId.length === 0 ||
      message.requestId.length > MAX_REQUEST_ID_LENGTH ||
      !REQUEST_ID_PATTERN.test(message.requestId)
    ) {
      return invalid("invalid_request_id");
    }
    if (
      !Number.isSafeInteger(message.timestampMs) ||
      message.timestampMs < 0 ||
      message.timestampMs > MAX_TIMESTAMP_MS
    ) {
      return invalid("invalid_timestamp");
    }

    return { ok: true, value: message };
  }

  function makeAck(requestId, timestampMs) {
    return {
      type: "ack",
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      receiverVersion: RECEIVER_VERSION,
      timestampMs
    };
  }

  function recordEvent(kind, code) {
    const event = {
      kind,
      code: typeof code === "string" && /^[a-z_]+$/.test(code) ? code : "none",
      timestampMs: Date.now()
    };
    telemetry.events.push(event);
    if (telemetry.events.length > MAX_EVENT_HISTORY) {
      telemetry.events.splice(0, telemetry.events.length - MAX_EVENT_HISTORY);
    }
    // Deliberately omit sender ID, message payload, network details, and errors.
    global.console.info("[screenmirror-webrtc-dev]", event);
    return event;
  }

  function snapshotTelemetry() {
    return Object.freeze({
      receiverVersion: RECEIVER_VERSION,
      namespace: NAMESPACE,
      received: telemetry.received,
      acknowledged: telemetry.acknowledged,
      rejected: telemetry.rejected,
      failures: telemetry.failures,
      recentEvents: telemetry.events.map((event) => ({ ...event }))
    });
  }

  function setVisibleState(state, detail) {
    if (!ui) {
      return;
    }
    ui.container.dataset.state = state;
    ui.connectionState.textContent = state === "error" ? "Error" : state;
    ui.lastEvent.textContent = detail;
    ui.statusDetail.textContent = detail;
  }

  function failVisible(code) {
    telemetry.failures += 1;
    recordEvent("receiver_failure", code);
    setVisibleState("error", "Receiver bootstrap failed: " + code);
  }

  function handleMessage(event) {
    if (!event || typeof event.senderId !== "string" || event.senderId.length === 0) {
      telemetry.rejected += 1;
      recordEvent("message_rejected", "invalid_sender");
      setVisibleState("Ready", "Rejected message: invalid_sender");
      return;
    }

    const validated = validatePing(event.data);
    if (!validated.ok) {
      telemetry.rejected += 1;
      recordEvent("message_rejected", validated.code);
      setVisibleState("Ready", "Rejected message: " + validated.code);
      return;
    }

    telemetry.received += 1;
    recordEvent("ping_received", "none");
    const ack = makeAck(validated.value.requestId, Date.now());

    try {
      receiverContext.sendCustomMessage(NAMESPACE, event.senderId, ack);
      telemetry.acknowledged += 1;
      recordEvent("ack_sent", "none");
      setVisibleState("Ready", "Ping acknowledged · receiver " + RECEIVER_VERSION);
    } catch (_) {
      failVisible("ack_send_failed");
    }
  }

  function boot() {
    ui = {
      container: document.querySelector(".receiver-status"),
      receiverVersion: document.getElementById("receiver-version"),
      connectionState: document.getElementById("connection-state"),
      lastEvent: document.getElementById("last-event"),
      statusDetail: document.getElementById("status-detail")
    };
    ui.receiverVersion.textContent = RECEIVER_VERSION;

    if (!global.cast || !global.cast.framework || !global.cast.framework.CastReceiverContext) {
      failVisible("caf_unavailable");
      return;
    }

    try {
      receiverContext = global.cast.framework.CastReceiverContext.getInstance();
      receiverContext.addCustomMessageListener(NAMESPACE, handleMessage);
      // Declare the custom namespace at receiver start, rather than relying
      // solely on the listener registration. CAF publishes this declaration
      // in the receiver metadata that the iOS sender uses to establish its
      // GCKGenericChannel.
      const receiverOptions = new global.cast.framework.CastReceiverOptions();
      receiverOptions.customNamespaces = {
        [NAMESPACE]: global.cast.framework.system.MessageType.JSON
      };
      receiverContext.start(receiverOptions);
      recordEvent("receiver_ready", "none");
      setVisibleState("Ready", "Listening on protocol v" + PROTOCOL_VERSION);
    } catch (_) {
      failVisible("caf_initialization_failed");
    }
  }

  global.ScreenMirrorReceiverBootstrap = Object.freeze({
    namespace: NAMESPACE,
    protocolVersion: PROTOCOL_VERSION,
    receiverVersion: RECEIVER_VERSION,
    maxMessageBytes: MAX_MESSAGE_BYTES,
    validatePing,
    makeAck,
    snapshotTelemetry
  });

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    } else {
      boot();
    }
  }
})(globalThis);
