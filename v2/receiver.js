(function receiverCapabilityGate(global) {
  "use strict";

  const RECEIVER_VERSION = "2.0.0";
  const RECEIVER_REVISION = "corr-fragseq-20260920-presentation";
  const PROTOCOL_VERSION = 2;
  const NAMESPACE = "urn:x-cast:com.ashwinbhajan.screenmirror.cmafprobe.v2";
  const MIME_TYPE = 'video/mp4; codecs="avc1.42e01f"';
  const MAX_MESSAGE_BYTES = 1024;
  const RETAINED_HISTORY_SECONDS = 2.5;
  const TRIM_HISTORY_THRESHOLD_SECONDS = 4;
  const LIVE_EDGE_FAST_THRESHOLD_SECONDS = 1.25;
  const LIVE_EDGE_NORMAL_THRESHOLD_SECONDS = 0.75;
  const LIVE_EDGE_FAST_PLAYBACK_RATE = 1.2;
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
  const SCREEN_COPY = Object.freeze({
    ready: Object.freeze(["Ready to Cast", "Open the app on your iPhone to begin."]),
    stopped: Object.freeze(["Casting Stopped", "Ready when you are. Start casting again from your iPhone."]),
    lost: Object.freeze(["Connection Lost", "We’re waiting for your iPhone. Check Wi‑Fi and start casting again."]),
    reconnecting: Object.freeze(["Reconnecting…", "Keep the app open on your iPhone."])
  });
  function showScreen(state) {
    if (!ui) return;
    const copy = SCREEN_COPY[state];
    ui.panel.hidden = state === "playing";
    document.body.classList.remove("receiver-waiting");
    if (state === "ready" || state === "reconnecting") document.body.classList.add("receiver-waiting");
    if (copy) { ui.title.textContent = copy[0]; ui.detail.textContent = copy[1]; }
  }
  function closeScreen(event, failed) {
    return !failed && event && event.code === 1000 && event.wasClean === true ? "stopped" : "lost";
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
    if (!Number.isFinite(currentTime) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    const inset = Math.min(0.05, Math.max(0, (end - start) / 2));
    if (currentTime < start) return start + inset;
    if (currentTime > end) return end - inset;
    return null;
  }
  function stalledLiveEdgeSeekTarget(currentTime, start, end) {
    if (!Number.isFinite(currentTime) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - currentTime < 0.05) return null;
    const target = Math.max(start + 0.05, end - 0.05);
    return target > currentTime + 0.02 ? target : null;
  }
  function bufferedTrimEnd(currentTime, start, end) {
    if (!Number.isFinite(currentTime) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    if (currentTime - start <= TRIM_HISTORY_THRESHOLD_SECONDS || end - currentTime < 0.5) return null;
    return Math.max(0, currentTime - RETAINED_HISTORY_SECONDS);
  }
  function liveEdgePlaybackRate(lead, currentRate) {
    if (!Number.isFinite(lead) || !Number.isFinite(currentRate)) return null;
    if (lead >= LIVE_EDGE_FAST_THRESHOLD_SECONDS) return LIVE_EDGE_FAST_PLAYBACK_RATE;
    if (currentRate > 1 && lead <= LIVE_EDGE_NORMAL_THRESHOLD_SECONDS) return 1;
    return null;
  }
  function makeLatencyStage(generation, sequence, stage, receiverTimeMs, bufferLeadMs, pendingDepth) {
    if (!Number.isInteger(generation) || generation <= 0 || !Number.isInteger(sequence) || sequence <= 0 ||
        !["received", "append_started", "append_ended"].includes(stage) || !Number.isFinite(receiverTimeMs) || receiverTimeMs < 0 ||
        !Number.isFinite(bufferLeadMs) || bufferLeadMs < 0 || !Number.isInteger(pendingDepth) || pendingDepth < 0 || pendingDepth > 8) return null;
    return { type: "latencyStage", generation, sequence, stage, receiverTimeMs, bufferLeadMs, pendingDepth };
  }
  function canConfirmFirstRendered(firstRendered, firstMediaAppended, metadata) {
    return !firstRendered && firstMediaAppended && Number.isFinite(metadata && metadata.presentedFrames) && metadata.presentedFrames > 0;
  }
  // Presentation-only gate. `waiting` is commonly emitted around a normal MSE
  // append; it must not replace visible video with the casting screen unless
  // playback has genuinely stopped advancing for the existing stall interval.
  function shouldShowReconnectingScreen(firstRendered, receiverStopped, playbackAdvancedAt, now, stallThresholdMs) {
    return !!firstRendered && !receiverStopped && Number.isFinite(playbackAdvancedAt) && Number.isFinite(now) && Number.isFinite(stallThresholdMs) && now - playbackAdvancedAt >= stallThresholdMs;
  }
  function renderedCorrelationStrategy(hasExactMatch, hasOrderedMatch) {
    if (hasExactMatch) return "media_time";
    if (hasOrderedMatch) return "append_order";
    return "unavailable";
  }
  // Diagnostic state only: no media payloads, credits, or queue ownership.
  function createFrameCorrelationTracker(generation, diagnostic, stage, rendered) {
    const fragments = []; const controls = new Map(); const callbacks = [];
    const maxFragments = 64; const maxCallbacks = 256; const ttlMs = 10000; const mediaToleranceSeconds = 0.5;
    const counts = {}; let closed = false;
    const emit = (reason) => { counts[reason] = (counts[reason] || 0) + 1; if (counts[reason] <= 8) diagnostic(reason); };
    let comparisonDiagnostics = 0;
    const fail = () => emit("rendered_frame_uncorrelated_no_fragment_match");
    const nearestFragment = (mediaTime, candidates) => candidates.reduce((best, item) => {
      const delta = Math.abs(item.mediaTime - mediaTime);
      return !best || delta < best.delta ? { item, delta } : best;
    }, null);
    const emitComparison = (prefix, control, candidate, retained) => {
      if (comparisonDiagnostics >= 8) return;
      comparisonDiagnostics += 1;
      const nearest = candidate ? candidate.item : null;
      diagnostic(`${prefix}_controlSeq_${Number.isInteger(control.sequence) ? control.sequence : "na"}_controlFragmentSeq_${Number.isInteger(control.fragmentSequence) ? control.fragmentSequence : "na"}_controlMediaMs_${Math.round(control.mediaTime * 1000)}_controlCapturePTS90k_${Number.isInteger(control.capturePTS90k) ? control.capturePTS90k : "na"}_controlCaptureDelta90k_${Number.isInteger(control.captureDelta90k) ? control.captureDelta90k : "na"}_nearestFragmentSeq_${nearest ? nearest.id : "na"}_nearestMediaMs_${nearest ? Math.round(nearest.mediaTime * 1000) : "na"}_deltaMs_${candidate ? Math.round(candidate.delta * 1000) : "na"}_generationMatch_${control.generation === generation ? 1 : 0}_retained_${retained}_appended_${nearest && nearest.appendedAt !== undefined ? 1 : 0}`);
    };
    const expire = (now) => {
      while (fragments.length && (now - fragments[0].receivedAt >= ttlMs || fragments.length > maxFragments)) {
        const item = fragments.shift();
        if (!item.correlation) emit("frame_correlation_late_bind_expired");
      }
      for (const [key, item] of controls) if (now - item.at >= ttlMs) controls.delete(key);
      while (callbacks.length && (now - callbacks[0].now >= ttlMs || callbacks.length > maxCallbacks)) { callbacks.shift(); fail(); }
    };
    const bind = (item, control) => {
      item.correlation = control;
      controls.delete(control.sequence);
      if (item.appendedAt !== undefined) emit("frame_correlation_late_bound");
      for (const [name, at] of [["received", item.receivedAt], ["append_started", item.startedAt], ["append_ended", item.appendedAt]]) {
        if (at !== undefined) stage(name, control.sequence, at, item.metrics[name]);
      }
    };
    const match = (frame) => {
      const appended = fragments.filter((item) => item.appendedAt !== undefined && item.appendedAt <= frame.now);
      // Match the actual fragment's decode-time interval before using ordered fallback.
      const exact = appended.find((item, index) => item.correlation &&
        frame.metadata.mediaTime >= item.mediaTime - 0.001 &&
        frame.metadata.mediaTime < (appended[index + 1] ? appended[index + 1].mediaTime : item.mediaTime + mediaToleranceSeconds));
      let item = exact;
      if (item && item.sent) return true;
      if (!item) {
        const nearest = nearestFragment(frame.metadata.mediaTime, appended.filter((candidate) => candidate.correlation && !candidate.sent));
        if (nearest && nearest.delta <= mediaToleranceSeconds) item = nearest.item;
      }
      // If the callback's media time is outside the retained range, use the
      // oldest appended correlated fragment as the bounded ordered fallback.
      // This is valid only when an exact control binding already exists.
      const unresolvedOlderFragment = appended.some((candidate) => !candidate.correlation && !candidate.sent && candidate.mediaTime <= frame.metadata.mediaTime);
      if (!item && !unresolvedOlderFragment) {
        item = appended.find((candidate) => candidate.correlation && !candidate.sent);
      }
      if (!item && !unresolvedOlderFragment) emitComparison("frame_correlation_render_no_match", { generation, mediaTime: frame.metadata.mediaTime }, nearestFragment(frame.metadata.mediaTime, appended), fragments.length);
      if (!item || !item.correlation) return false;
      if (!item.sent) { item.sent = true; rendered(frame.now, frame.metadata, item.correlation); }
      return true;
    };
    const retry = () => { for (let i = 0; i < callbacks.length;) { if (match(callbacks[i])) callbacks.splice(i, 1); else i += 1; } };
    return {
      receive(id, mediaTime, now, metrics) {
        if (closed) return null;
        expire(now);
        const item = { id, mediaTime, receivedAt: now, metrics: { received: metrics } };
        fragments.push(item); expire(now);
        const controlByFragmentID = Array.from(controls.values()).find((control) => control.fragmentSequence === id) || controls.get(id);
        const candidate = controlByFragmentID
          ? { item: controlByFragmentID, delta: Math.abs(controlByFragmentID.mediaTime - mediaTime) }
          : nearestFragment(mediaTime, Array.from(controls.values()));
        const control = candidate && candidate.delta <= mediaToleranceSeconds ? candidate.item : null;
        if (controlByFragmentID || control) bind(item, controlByFragmentID || control);
        return item;
      },
      start(item, now, metrics) { if (!item || closed) return; item.startedAt = now; item.metrics.append_started = metrics; if (item.correlation) stage("append_started", item.correlation.sequence, now, metrics); },
      append(item, now, metrics) { if (!item || closed) return; item.appendedAt = now; item.metrics.append_ended = metrics; if (item.correlation) stage("append_ended", item.correlation.sequence, now, metrics); expire(now); retry(); },
      control(value, now) {
        if (closed || value.generation !== generation || value.sequence <= 0 || !Number.isFinite(value.mediaTimeMs)) return;
        expire(now);
        const control = { generation, sequence: value.sequence, fragmentSequence: Number.isInteger(value.fragmentSequence) ? value.fragmentSequence : null, mediaTime: value.mediaTimeMs / 1000, capturePTS90k: Number.isInteger(value.capturePTS90k) ? value.capturePTS90k : null, captureDelta90k: Number.isInteger(value.captureDelta90k) ? value.captureDelta90k : null, at: now };
        const fragmentByID = fragments.find((item) => !item.correlation && item.id === (control.fragmentSequence || control.sequence));
        const candidate = fragmentByID
          ? { item: fragmentByID, delta: Math.abs(fragmentByID.mediaTime - control.mediaTime) }
          : nearestFragment(control.mediaTime, fragments.filter((item) => !item.correlation));
        if (fragmentByID || (candidate && candidate.delta <= mediaToleranceSeconds)) { bind(fragmentByID || candidate.item, control); retry(); }
        else {
          if (!fragments.length) {
            controls.set(control.sequence, control); if (controls.size > maxFragments) controls.delete(controls.keys().next().value);
            return;
          }
          emitComparison("frame_correlation_control_no_match", control, nearestFragment(control.mediaTime, fragments), fragments.length);
          controls.set(control.sequence, control); if (controls.size > maxFragments) controls.delete(controls.keys().next().value);
        }
      },
      frame(now, metadata) { if (closed) return; expire(now); const frame = { now, metadata }; if (!match(frame)) { callbacks.push(frame); expire(now); } },
      finish(now) { if (closed) return; expire(now); retry(); while (callbacks.length) { callbacks.shift(); fail(); } closed = true; fragments.length = 0; controls.clear(); },
      snapshot: () => ({ fragments: fragments.length, controls: controls.size, callbacks: callbacks.length, counts: { ...counts } })
    };
  }
  function createFramePacingSummary(emit) {
    // Fixed histogram: full-session percentiles rounded up to 1 ms; >10 s is overflow.
    const cadence = () => ({ count: 0, first: null, last: null, max: 0, bursts: 0, histogram: new Uint32Array(10002) });
    const render = cadence(); const append = cadence();
    let firstPresented = null; let lastPresented = null; let presentedJumps = 0; let finished = false;
    const add = (value, now) => {
      if (value.last !== null) { const interval = Math.max(0, now - value.last); value.max = Math.max(value.max, interval); if (interval < 8) value.bursts += 1; value.histogram[Math.min(10001, Math.ceil(interval))] += 1; }
      if (value.first === null) value.first = now;
      value.last = now; value.count += 1;
    };
    const summarize = (value) => {
      const percentile = (fraction) => { const target = Math.ceil((value.count - 1) * fraction); if (target <= 0) return null; let count = 0; for (let i = 0; i < value.histogram.length; i += 1) { count += value.histogram[i]; if (count >= target) return i; } return null; };
      return { count: value.count, durationMs: value.count > 1 ? Math.round(value.last - value.first) : 0, p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: value.count > 1 ? Math.round(value.max) : null, burstUnder8Ms: value.bursts, intervalOverflow: value.histogram[10001] };
    };
    return {
      frame(now, metadata) {
        if (finished) return;
        add(render, now);
        if (Number.isFinite(metadata.presentedFrames)) { if (firstPresented === null) firstPresented = metadata.presentedFrames; if (lastPresented !== null && metadata.presentedFrames - lastPresented > 1) presentedJumps += 1; lastPresented = metadata.presentedFrames; }
      },
      append(now) { if (!finished) add(append, now); },
      stop(counts) {
        if (finished) return null;
        finished = true;
        const r = summarize(render); const a = summarize(append);
        const delta = firstPresented === null ? null : Math.max(0, lastPresented - firstPresented);
        const summary = { render: r, append: a, presentedFramesDelta: delta, presentedFPSMilli: delta !== null && r.durationMs > 0 ? Math.round(delta * 1000000 / r.durationMs) : null, presentedJumps, uncorrelated: counts.rendered_frame_uncorrelated_no_fragment_match || 0, lateBound: counts.frame_correlation_late_bound || 0, lateBindExpired: counts.frame_correlation_late_bind_expired || 0 };
        // Numeric, allowlisted category characters survive the existing iOS diagnostic exporter.
        const fields = (object) => Object.entries(object).map(([key, value]) => `${key}_${value === null ? "na" : value}`).join("_");
        emit(`frame_pacing_summary_render_${fields(r)}`);
        emit(`frame_pacing_summary_append_${fields(a)}`);
        emit(`frame_pacing_summary_presentedFramesDelta_${delta === null ? "na" : delta}_presentedFPSMilli_${summary.presentedFPSMilli === null ? "na" : summary.presentedFPSMilli}_presentedJumps_${presentedJumps}_uncorrelated_no_fragment_match_${summary.uncorrelated}_lateBound_${summary.lateBound}_lateBindExpired_${summary.lateBindExpired}`);
        return summary;
      }
    };
  }
  function send(senderId, requestId, result) {
    context.sendCustomMessage(NAMESPACE, senderId, makeResult(requestId, result));
  }
  function probeWebSocket(event) {
    const request = validateProbe(event.data);
    if (!event || !event.senderId || !request) { return; }
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
    if (["receiver_first_message_received", "receiver_auth_validation_passed", "receiver_media_ready_received"].includes(result)
        || result.startsWith("first_frame_callback_presented_") || result.startsWith("first_fragment_seq_")) {
      payload.receiverUptimeMs = performance.now();
    }
    if (telemetry) payload.telemetry = telemetry;
    context.sendCustomMessage(NAMESPACE, senderId, payload);
  }
  function createMediaCreditEmitter(generation, send) {
    let creditSequence = 0;
    return () => {
      creditSequence += 1;
      const credit = { type: "mediaCredit", protocolVersion: PROTOCOL_VERSION, generation, credits: 1, creditSequence };
      if (global.console && typeof global.console.info === "function") global.console.info("ScreenMirror mediaCredit", { generation, creditSequence });
      send(credit);
    };
  }
  // Diagnostic fingerprint only. Includes actual startup/playback code and closed-over
  // settings plus receiver capabilities; never includes request IDs, endpoints or tokens.
  // FNV-1a is a comparison checksum, not a security hash.
  function effectiveReceiverConfigHash(runtime) {
    const value = JSON.stringify({ schema: 1, revision: RECEIVER_REVISION,
      protocolVersion: PROTOCOL_VERSION, namespace: NAMESPACE, mime: MIME_TYPE,
      maxMessageBytes: MAX_MESSAGE_BYTES, retainedHistorySeconds: RETAINED_HISTORY_SECONDS,
      trimHistoryThresholdSeconds: TRIM_HISTORY_THRESHOLD_SECONDS,
      fastThresholdSeconds: LIVE_EDGE_FAST_THRESHOLD_SECONDS,
      normalThresholdSeconds: LIVE_EDGE_NORMAL_THRESHOLD_SECONDS,
      fastPlaybackRate: LIVE_EDGE_FAST_PLAYBACK_RATE,
      implementation: [runMedia, recoverySeekTarget, stalledLiveEdgeSeekTarget, bufferedTrimEnd, liveEdgePlaybackRate].map(String),
      runtime: { frameCallback: !!runtime.frameCallback, mediaSource: !!runtime.mediaSource,
        avcMIME: !!runtime.avcMIME, sourceBuffer: !!runtime.sourceBuffer, autoplay: runtime.autoplay } });
    let hash = 2166136261;
    for (const byte of new TextEncoder().encode(value)) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    return `fnv1a32_${hash.toString(16).padStart(8, "0")}`;
  }
  function runMedia(event, request) {
    if (!capabilityResult()) { sendMediaResult(event.senderId, request.requestId, "unsupported"); return; }
    const video = document.getElementById("probe-video");
    document.body.classList.add("media-active");
    document.body.classList.remove("receiver-idle");
    sendMediaResult(event.senderId, request.requestId, `receiver_revision_reported_${RECEIVER_REVISION}`);
    try { sendMediaResult(event.senderId, request.requestId, `effective_receiver_config_hash_${effectiveReceiverConfigHash({
      ...capabilities, frameCallback: typeof video.requestVideoFrameCallback === "function"
    })}`); } catch (_) { /* Diagnostics never gate media startup. */ }
    const pending = []; const maxPending = 8;
    const flowGeneration = 1; const initialCredits = 8; let mediaReadySent = false;
    let source; let buffer; let socket; let firstKeyframe = false; let firstMediaAppended = false; let lastAppendingType = 0; let lastAppendingFragment = null; let firstRendered = false; let playAttempted = false; let initialSeekRequested = false; let initialSeekCompleted = false; let recoverySeekPending = false; let timeUpdated = false; let appendBacklogHighWatermark = 0; let appendedFragments = 0; let initAppendPending = false; let initAppendTimeout; let mediaAppendPending = false; let playTimeout; let receiverStopped = false; let stallThresholdMs = 1500; let recoveryTailSeconds = 0.05; let recoveryMinimumLeadSeconds = 0.05; let recoveryTimeoutMs = 3000; let lastPlayback = { time: 0, advancedAt: performance.now(), recoveryAwaitingProgress: false, recoveryTimeout: undefined };
    let reconnectingScreenTimer;
    let latencyFallback = false; let frameCallbackID;
    // Preserve the existing timeupdate fallback on receivers without rVFC.
    const latencyCorrelations = new Map();
    const sendLatency = (value) => { try { if (socket && socket.readyState === 1) socket.send(JSON.stringify(value)); } catch (_) {} };
    const captureStageMetrics = () => ({ bufferLeadMs: Math.round(bufferedLead(video) * 1000), pendingDepth: Math.max(0, Math.min(maxPending, pending.length)) });
    const sendLatencyStage = (stage, sequence, at, metrics) => {
      const message = makeLatencyStage(flowGeneration, sequence, stage, at, metrics.bufferLeadMs, metrics.pendingDepth);
      if (message) sendLatency(message);
    };
    // Each runMedia call owns one receiver generation/session, so this counter
    // resets when that session is replaced while remaining monotonic in-session.
    const emitMediaCredit = createMediaCreditEmitter(flowGeneration, sendLatency);
    const confirmFirstRendered = (metadata) => {
      if (!canConfirmFirstRendered(firstRendered, firstMediaAppended, metadata)) return;
      firstRendered = true;
      const presentedFrames = Math.max(1, Math.floor(metadata.presentedFrames));
      sendMediaResult(event.senderId, request.requestId, `first_frame_callback_presented_${presentedFrames}`);
      context.sendCustomMessage(NAMESPACE, event.senderId, { type: "firstRenderedFrame", protocolVersion: PROTOCOL_VERSION, requestId: request.requestId, receiverVersion: RECEIVER_VERSION, appendBacklogHighWatermark });
    };
    const pacing = createFramePacingSummary((result) => sendMediaResult(event.senderId, request.requestId, result));
    const correlations = createFrameCorrelationTracker(flowGeneration,
      (result) => sendMediaResult(event.senderId, request.requestId, result), sendLatencyStage,
      (now, metadata, correlation) => sendLatency({ type: "renderedFrame", generation: correlation.generation, sequence: correlation.sequence, receiverTimeMs: now, mediaTimeMs: Math.round(metadata.mediaTime * 1000), presentedFrames: Number.isFinite(metadata.presentedFrames) ? metadata.presentedFrames : 0, bufferLeadMs: metadata.bufferLeadMs }));
    const observeFrame = (now, metadata) => {
      if (receiverStopped) return;
      confirmFirstRendered(metadata);
      pacing.frame(now, metadata);
      correlations.frame(now, { ...metadata, bufferLeadMs: Math.round(bufferedLead(video) * 1000) });
    };
    const installFrameObserver = () => {
      if (typeof video.requestVideoFrameCallback === "function") {
        sendLatency({ type: "latencyCapability", mode: "requestVideoFrameCallback" });
        const next = (now, metadata) => { if (receiverStopped) return; observeFrame(now, metadata); frameCallbackID = video.requestVideoFrameCallback(next); };
        frameCallbackID = video.requestVideoFrameCallback(next);
      } else { latencyFallback = true; sendLatency({ type: "latencyCapability", mode: "playbackAckFallback" }); }
    };
    const clearInitAppendTimeout = () => { if (initAppendTimeout) { global.clearTimeout(initAppendTimeout); initAppendTimeout = undefined; } };
    const clearPlayTimeout = () => { if (playTimeout) { global.clearTimeout(playTimeout); playTimeout = undefined; } };
    const clearRecoveryTimeout = () => { if (lastPlayback.recoveryTimeout) { global.clearTimeout(lastPlayback.recoveryTimeout); lastPlayback.recoveryTimeout = undefined; } };
    const clearReconnectingScreenTimer = () => { if (reconnectingScreenTimer) { global.clearTimeout(reconnectingScreenTimer); reconnectingScreenTimer = undefined; } };
    const scheduleReconnectingScreen = () => {
      if (receiverStopped || !firstRendered || reconnectingScreenTimer) return;
      reconnectingScreenTimer = global.setTimeout(() => {
        reconnectingScreenTimer = undefined;
        if (shouldShowReconnectingScreen(firstRendered, receiverStopped, lastPlayback.advancedAt, performance.now(), stallThresholdMs)) showScreen("reconnecting");
      }, stallThresholdMs);
    };
    const clearVideoForReceiverStop = (screen) => {
      if (receiverStopped) return;
      receiverStopped = true;
      correlations.finish(performance.now());
      pacing.stop(correlations.snapshot().counts);
      if (frameCallbackID !== undefined && typeof video.cancelVideoFrameCallback === "function") video.cancelVideoFrameCallback(frameCallbackID);
      clearRecoveryTimeout();
      clearReconnectingScreenTimer();
      pending.length = 0;
      try { video.pause(); video.removeAttribute("src"); video.load(); } catch (_) {}
      document.body.classList.remove("media-active");
      document.body.classList.add("receiver-idle");
      showScreen(screen);
      sendMediaResult(event.senderId, request.requestId, "receiver_video_cleared");
      sendMediaResult(event.senderId, request.requestId, "receiver_idle_screen_shown");
      if (screen === "stopped") sendMediaResult(event.senderId, request.requestId, "receiver_casting_stopped_screen_shown");
      if (screen === "lost") sendMediaResult(event.senderId, request.requestId, "receiver_connection_lost_screen_shown");
    };
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
      sendMediaResult(event.senderId, request.requestId, "receiver_live_edge_recovery_seek");
      try { video.currentTime = target; } catch (_) { recoverySeekPending = false; sendMediaResult(event.senderId, request.requestId, "recovery_seek_failed"); }
    };
    const detectPlaybackStall = () => {
      if (!initialSeekCompleted || recoverySeekPending || !firstRendered || video.paused || video.ended || !video.buffered || !video.buffered.length) return;
      const start = video.buffered.start(0); const end = video.buffered.end(video.buffered.length - 1);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end - video.currentTime < recoveryMinimumLeadSeconds) return;
      if (performance.now() - lastPlayback.advancedAt < stallThresholdMs) return;
      const target = stalledLiveEdgeSeekTarget(video.currentTime, start, end);
      if (target === null || target - video.currentTime < 0.02) return;
      playbackTelemetry("receiver_playback_stall_detected");
      sendMediaResult(event.senderId, request.requestId, "receiver_playback_stall_detected");
      recoverySeekPending = true;
      lastPlayback.recoveryAwaitingProgress = true;
      sendMediaResult(event.senderId, request.requestId, "receiver_live_edge_recovery_seek");
      try {
        video.currentTime = target;
        clearRecoveryTimeout();
        lastPlayback.recoveryTimeout = global.setTimeout(() => {
          if (!lastPlayback.recoveryAwaitingProgress) return;
          lastPlayback.recoveryAwaitingProgress = false;
          sendMediaResult(event.senderId, request.requestId, "receiver_playback_recovery_failed");
          playbackTelemetry("receiver_playback_recovery_failed");
        }, recoveryTimeoutMs);
      } catch (_) {
        recoverySeekPending = false; lastPlayback.recoveryAwaitingProgress = false;
        sendMediaResult(event.senderId, request.requestId, "receiver_playback_recovery_failed");
      }
    };
    const regulateLiveEdge = () => {
      const nextRate = liveEdgePlaybackRate(bufferedLead(video), video.playbackRate);
      if (nextRate === null || nextRate === video.playbackRate) return;
      video.playbackRate = nextRate;
      sendMediaResult(event.senderId, request.requestId, nextRate > 1 ? "live_edge_catchup_enabled" : "live_edge_catchup_disabled");
    };
    const appendNext = () => {
      if (!buffer || buffer.updating || !pending.length) return;
      const item = pending.shift(); lastAppendingType = item.type; lastAppendingFragment = item.fragment || null;
      if (item.type === 1) {
        initAppendPending = true;
        sendMediaResult(event.senderId, request.requestId, `init_append_started_len_${item.payload.byteLength}`);
        initAppendTimeout = global.setTimeout(() => {
          if (initAppendPending) { sendMediaResult(event.senderId, request.requestId, "init_append_timeout"); stop("append_failed"); }
        }, 5000);
      }
      if (item.type === 2) {
        mediaAppendPending = true;
        correlations.start(lastAppendingFragment, performance.now(), captureStageMetrics());
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
              if (!mediaReadySent) { mediaReadySent = true;
                try { sendMediaResult(event.senderId, request.requestId, "receiver_media_ready_received"); } catch (_) {}
                sendLatency({ type: "mediaReady", protocolVersion: PROTOCOL_VERSION, generation: flowGeneration, initialCredits }); }
            }
            if (lastAppendingType === 2) firstMediaAppended = true;
            if (lastAppendingType === 2 && mediaAppendPending) {
              mediaAppendPending = false;
              appendedFragments += 1;
              correlations.append(lastAppendingFragment, performance.now(), captureStageMetrics());
              pacing.append(performance.now());
              sendMediaResult(event.senderId, request.requestId, "media_append_updateend");
              if (mediaReadySent) emitMediaCredit();
              playbackTelemetry("first_media_append");
            }
            ensurePlayablePosition();
            attemptPlay();
            recoverPlaybackPosition();
            detectPlaybackStall();
            regulateLiveEdge();
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
          socket.onopen = () => { socket.send(JSON.stringify({ type: "hello", token: new URL(request.endpoint).pathname.slice(1), protocolVersion: PROTOCOL_VERSION })); installFrameObserver(); };
          socket.onmessage = (message) => {
            if (typeof message.data === "string") {
              const control = parse(message.data); if (!control) { stop("protocol_error"); return; }
              if (control.type === "readyForMedia") {
                try { sendMediaResult(event.senderId, request.requestId, "receiver_auth_validation_passed"); } catch (_) {}
                return;
              }
              if (control.type === "normalStop" && control.protocolVersion === PROTOCOL_VERSION && Object.keys(control).length === 2) {
                sendMediaResult(event.senderId, request.requestId, "receiver_stop_received");
                clearVideoForReceiverStop("stopped");
                try { socket.close(1000, "normal_stop"); } catch (_) {}
                return;
              }
              if (control.type === "clockPing" && Number.isFinite(control.t1) && Number.isInteger(control.sequence)) { const t2 = performance.now(); sendLatency({ type: "clockPong", sequence: control.sequence, t1: control.t1, t2, t3: performance.now() }); return; }
              if (control.type === "frameCorrelation" && Number.isInteger(control.generation) && Number.isInteger(control.sequence) && Number.isFinite(control.mediaTimeMs)) { correlations.control(control, performance.now());
                if (latencyFallback) {
                  if (latencyCorrelations.size >= 256) latencyCorrelations.delete(latencyCorrelations.keys().next().value);
                  latencyCorrelations.set(control.sequence, { generation: control.generation, sequence: control.sequence, mediaTime: control.mediaTimeMs / 1000 });
                }
                return;
              }
              stop("protocol_error"); return;
            }
            const envelope = parseEnvelope(message.data); if (!envelope) { stop("binary_envelope_invalid"); return; }
            if (envelope.type === 1) { enqueue(envelope); return; }
            if (envelope.type === 2) {
              const summary = summarizeFragment(envelope.payload);
              let fragment = null;
              if (summary) {
                fragment = correlations.receive(envelope.sequence, summary.decodeTime / 90000, performance.now(), captureStageMetrics());
                sendMediaResult(event.senderId, request.requestId, `media_fragment_received_len_${envelope.payload.byteLength}`);
                sendMediaResult(event.senderId, request.requestId, `first_fragment_seq_${summary.sequence}_samples_${summary.sampleCount}_tfdt_${summary.decodeTime}_offset_${summary.dataOffset}_payload_${summary.payloadLength}_nal_${summary.firstNALType}`);
              } else {
                sendMediaResult(event.senderId, request.requestId, "media_fragment_layout_invalid");
              }
              firstKeyframe = true; enqueue({ ...envelope, fragment }); return;
            }
            stop("binary_envelope_invalid");
          };
          let socketFailed = false;
          socket.onerror = () => { socketFailed = true; stop("websocket_failed"); }; socket.onclose = (closeEvent) => {
            if (!receiverStopped) {
              sendMediaResult(event.senderId, request.requestId, "receiver_stop_received");
              clearVideoForReceiverStop(closeScreen(closeEvent, socketFailed));
            }
            if (!firstRendered) sendMediaResult(event.senderId, request.requestId, "websocket_closed");
          };
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
      video.addEventListener("waiting", () => {
        scheduleReconnectingScreen();
        sendMediaResult(event.senderId, request.requestId, "media_event_waiting");
      });
      video.addEventListener("stalled", () => {
        scheduleReconnectingScreen();
        sendMediaResult(event.senderId, request.requestId, "media_event_stalled");
      });
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
        clearReconnectingScreenTimer();
        if (!receiverStopped && !ui.panel.hidden) showScreen("playing");
        sendMediaResult(event.senderId, request.requestId, "media_event_playing");
      });
      video.addEventListener("timeupdate", () => {
        if (!timeUpdated) { timeUpdated = true; sendMediaResult(event.senderId, request.requestId, "media_event_timeupdate"); }
        if (video.currentTime > lastPlayback.time + 0.01) {
          lastPlayback.time = video.currentTime;
          lastPlayback.advancedAt = performance.now();
          if (lastPlayback.recoveryAwaitingProgress) {
            lastPlayback.recoveryAwaitingProgress = false;
            clearRecoveryTimeout();
            sendMediaResult(event.senderId, request.requestId, "receiver_playback_recovered");
            playbackTelemetry("receiver_playback_recovered");
          }
        }
        if (latencyFallback && latencyCorrelations.size) { const mediaTime = video.currentTime; const nearest = Array.from(latencyCorrelations.values()).sort((a, b) => Math.abs(a.mediaTime - mediaTime) - Math.abs(b.mediaTime - mediaTime))[0]; if (nearest && Math.abs(nearest.mediaTime - mediaTime) <= 0.05) { latencyCorrelations.delete(nearest.sequence); sendLatency({ type: "renderedFrame", generation: nearest.generation, sequence: nearest.sequence, receiverTimeMs: performance.now(), mediaTimeMs: Math.round(mediaTime * 1000), presentedFrames: 0, bufferLeadMs: Math.round(bufferedLead(video) * 1000), fallback: true }); } }
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
    const media = event && validateMediaStart(event.data); if (media) {
      try { sendMediaResult(event.senderId, media.requestId, "receiver_first_message_received"); } catch (_) {}
      capabilityReadyPromise.then(() => runMedia(event, media)); return;
    }
    // Unrecognized commands have no user-facing presentation.
  }
  function runWebSocketProbe(senderId, request) {
    if (!capabilityResult()) { send(senderId, request.requestId, RESULT.FAILED); return; }
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
      // Probe completion does not overwrite the casting screen.
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

      return capabilities;
    });
  }
  function boot() {
    ui = { panel: document.getElementById("idle-screen"), title: document.getElementById("status-title"), detail: document.getElementById("status-detail"), version: document.getElementById("receiver-version") };
    // This isolated /v2 entry point is exclusively the Debug receiver.
    ui.version.textContent = `Receiver ${RECEIVER_VERSION} · ${RECEIVER_REVISION}`;
    showScreen("ready");
    const video = document.getElementById("probe-video");
    capabilityReadyPromise = testCapabilities(video);
    if (!global.cast || !global.cast.framework) { showScreen("lost"); return; }
    context = global.cast.framework.CastReceiverContext.getInstance();
    context.addCustomMessageListener(NAMESPACE, receiverMessage);
    const options = new global.cast.framework.CastReceiverOptions();
    options.customNamespaces = { [NAMESPACE]: global.cast.framework.system.MessageType.JSON };
    context.start(options);

  }
  global.ScreenMirrorReceiverCapabilityGate = Object.freeze({ effectiveReceiverConfigHash, SCREEN_COPY, closeScreen, MIME_TYPE, RESULT, validEndpoint, validateProbe, recoverySeekTarget, stalledLiveEdgeSeekTarget, bufferedTrimEnd, liveEdgePlaybackRate, makeLatencyStage, canConfirmFirstRendered, shouldShowReconnectingScreen, renderedCorrelationStrategy, createMediaCreditEmitter, createFrameCorrelationTracker, createFramePacingSummary, receiverRevision: RECEIVER_REVISION, receiverStopDiagnostics: Object.freeze(["receiver_stop_received", "receiver_video_cleared", "receiver_idle_screen_shown", "receiver_casting_stopped_screen_shown", "receiver_connection_lost_screen_shown"]), capabilityResult: () => capabilityResult(), snapshot: () => ({ ...capabilities }) });
  if (typeof document !== "undefined") document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", boot, { once: true }) : boot();
})(globalThis);
