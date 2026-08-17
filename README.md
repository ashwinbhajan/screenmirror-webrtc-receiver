# Screen Mirror WebRTC Development Receiver

This is an isolated **development-only** Custom Cast Receiver bootstrap for the
Phase 2 capability pilot. It is intentionally limited to a CAF custom-namespace
`ping`/`ack` exchange and privacy-safe telemetry.

It contains no `RTCPeerConnection`, SDP, ICE, DTLS, audio, video transport,
HLS, MSE, retry logic, or production UI. It must never replace or be deployed
to the published `screenmirror-receiver` repository used by `EDB6221E`.

## Repository and URL

Transfer this directory unchanged into a new repository named
`screenmirror-webrtc-receiver`. Use GitHub Pages from the `main` branch and the
repository root. The intended receiver URL is:

```text
https://<github-owner>.github.io/screenmirror-webrtc-receiver/v1/receiver.html
```

`<github-owner>` remains an owner-supplied value. Do not substitute a production
host or application ID.

## Local checks

From the receiver repository root:

```sh
node --test v1/tests/receiver-schema.test.js
node --check v1/receiver.js
python3 -m http.server 8080
```

Then open `http://127.0.0.1:8080/v1/receiver.html`. A normal browser cannot
provide the Cast receiver runtime, so its visible `caf_unavailable` state is
expected. It proves only that the static assets load; it is not Cast-device
evidence.

## GitHub Pages deployment (owner-operated)

1. Create a new repository named `screenmirror-webrtc-receiver`; do not fork or
   alter `screenmirror-receiver`.
2. Copy this directory's contents to the new repository root and commit them.
3. In **Settings → Pages**, select **Deploy from a branch**, branch `main`,
   folder `/ (root)`, and save.
4. Wait for Pages to report a successful deployment, then retrieve the intended
   HTTPS URL above and verify HTTP 200.
5. Compute and record the deployed asset hashes without storing credentials:

   ```sh
   curl --fail --silent --show-error --location \
     https://<github-owner>.github.io/screenmirror-webrtc-receiver/v1/receiver.html | shasum -a 256
   curl --fail --silent --show-error --location \
     https://<github-owner>.github.io/screenmirror-webrtc-receiver/v1/receiver.js | shasum -a 256
   curl --fail --silent --show-error --location \
     https://<github-owner>.github.io/screenmirror-webrtc-receiver/v1/styles.css | shasum -a 256
   ```

6. Preserve the deployment commit SHA and hashes with the private release
   evidence. Do not put credentials, device serials, or the generated Cast
   application ID in this repository.

## Rollback

The first deployment is `v1`. Before changing it, tag the known-good commit.
To roll back, restore that exact commit to `main`, wait for Pages deployment,
and re-check the three hashes. For a material protocol change, publish `v2/`
and create a new **unpublished** development receiver registration rather than
silently changing the v1 protocol.

## Cast Console owner step

Only after the HTTPS URL is live, the Cast Console owner creates a new
application:

| Field | Required value |
| --- | --- |
| Name | `Screen Mirror WebRTC Dev` |
| Type | Custom Receiver |
| Receiver URL | The isolated `v1/receiver.html` HTTPS URL |
| Publication state | Unpublished |

The owner must register the physical test device in the same Cast developer
account, retain its serial outside source control, and then provide only the
generated development application ID, device model, firmware/build, and Ready
For Testing status. Never use `EDB6221E`.

## Bootstrap protocol

Namespace: `urn:x-cast:com.ashwinbhajan.screenmirror.webrtc.v1`
Protocol version: `1`
Receiver version: `1.0.0`

The receiver accepts only a JSON object (or JSON string encoding it) with the
four exact fields below. Serialized messages are capped at 1024 UTF-8 bytes.

```json
{
  "type": "ping",
  "protocolVersion": 1,
  "requestId": "bounded-id",
  "timestampMs": 0
}
```

For a valid message it returns:

```json
{
  "type": "ack",
  "protocolVersion": 1,
  "requestId": "bounded-id",
  "receiverVersion": "1.0.0",
  "timestampMs": 0
}
```

Malformed, oversized, unexpected-field, unsupported-version, invalid-ID, and
invalid-timestamp messages are rejected. Telemetry retains only bounded event
kind/code/timestamp counters; it never retains payloads, sender IDs, IP
addresses, secrets, SDP, ICE candidates, or raw errors.

## v2 CMAF receiver-runtime gate

`v2/receiver.html` is a Debug-only **capability gate**, not a media receiver.
Deploy it as a separate versioned Pages path and register a new unpublished
Custom Receiver application. Do not repoint `A48EE765` or edit `/v1`.

Before the physical test, configure the Debug app with:

```text
SCREEN_MIRROR_ENABLE_CMAF_RECEIVER_PROBE=1
SCREEN_MIRROR_CMAF_RECEIVER_APPLICATION_ID=<new app ID>
```

Start a Debug broadcast first; this creates a one-client, control-only local
`ws://` endpoint inside the Broadcast Upload Extension. In Settings, choose
the target Cast device and run **CMAF Receiver 2D-0**. The receiver verifies
WebSocket, MSE, `avc1.42e01f` ISO-BMFF support, SourceBuffer creation, muted
autoplay, and exactly one token-authenticated WebSocket acknowledgement.

If an HTTPS receiver blocks `ws://`, stop the WebSocket/MSE branch. Do not use
self-signed certificates, a private CA, TLS bypasses, CSP changes, or Cast
private APIs. A `wss://` retry is permissible only when the owner has a real
local hostname and certificate trusted by the target Cast device. Otherwise
hand off to the HTTP/chunked-CMAF capability evaluation; do not add media or a
CMAF fragmenter.
