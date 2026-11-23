# MECON USB Connector

A small headless service that carries messages between a MECON public-firmware radio on a USB serial port and a Backend, over one of two transports. It is transport only.

```
USB radio  <-- serial framing -->  Connector  <-- MQTT 3.1.1 / TLS -->  broker  <-->  Backend      (transport = "mqtt", the default)
USB radio  <-- serial framing -->  Connector  <-- WebSocket / TLS ---------------->  Backend      (transport = "hold", recommended for a standing Connector)
```

**What it does not do.** It never mints or substitutes identity, holds keys, decrypts or rewrites a payload, fabricates an acknowledgement, or chooses a device or identity. It reads an uplink message only for its `id`, `ev`, `epoch` and `usig` members (the topic to publish to, and the enrolment gate). A device-signed envelope leaves exactly as it arrived. MQTT accepting a message is not RF delivery and not Backend processing, and the Connector never reports it as either.

**Status: stages C0, C1 and the packaging of C2 of the [implementation design](../docs/USB_CONNECTOR_IMPLEMENTATION_DESIGN.md), and the preparation of C3 (Backend topic mapping, explicit port selection, a bench harness).** A second transport, the WebSocket hold, is implemented against its contract and a fake Backend endpoint (see [Hold transport](#hold-transport-recommended-for-a-standing-connector)). It passes its unit tests, fake-device tests and a real-mosquitto integration test; the install scripts run in a Debian container and the unit under real systemd on a CI VM. It has not been run on a real device, a Pi, or against a live Backend. See [What is not verified](#what-is-not-verified).

The MQTT wire contract (frames, topics, QoS, retry rules, metrics) is in [`contracts/connector/v1`](../contracts/connector/v1/README.md); the hold's is in [`contracts/connector-hold/v1`](../contracts/connector-hold/v1/README.md). The topic and ACL mapping is the Backend's (relayed for stage C3); it has not yet run against a real device or Backend.

## Language and runtime

Python 3.11 or newer, three pinned dependencies (`paho-mqtt` for the MQTT transport, `websockets` for the hold, `pyserial`), all used in their pure-Python form. The design document names no language. Python was chosen for a 512 MB Pi Zero 2 W because:

- it needs no native build or prebuilt binary on arm64 or 32-bit arm (`serialport` for Node ships native code per platform);
- the whole service is one process of a few MB plus the interpreter, with a single-threaded bridge loop plus the MQTT library's network thread;
- the framing and safety rules read as short, testable functions, and `python:3.12-slim` is on every Pi OS and container host.

The cost is the interpreter's memory (expected in the tens of MB; **not measured on a Pi**, see below). A Go or Rust rewrite would be smaller and is not ruled out; the contract and fixtures are language-neutral.

## Run

```sh
cd connector
python3 -m venv .venv && . .venv/bin/activate
pip install --require-hashes --no-deps -r requirements.lock && pip install --no-deps .
python -m mecon_connector --list-ports                       # find the stable id
cp config.example.toml config.toml && $EDITOR config.toml
python -m mecon_connector --check-config --config config.toml
python -m mecon_connector --config config.toml
```

Docker (from the repository root; the image is non-root and builds for amd64, arm64 and armv7):

```sh
docker build -f connector/Dockerfile --target runtime -t mecon-connector .
docker run -d --name mecon-connector --restart unless-stopped \
  --device /dev/serial/by-id/usb-YOUR_DEVICE-if00 --group-add "$(stat -c %g /dev/ttyACM0)" \
  -v /etc/mecon-connector:/etc/mecon-connector:ro -p 127.0.0.1:9464:9464 mecon-connector
```

Pass the device node by its by-id path, and the group that owns it, so the unprivileged user can open it. The Connector opens the port exclusively; nothing else (a browser, a terminal) can use it while the service runs.

## Configuration

One TOML file, validated at start. Every problem is listed and the process exits with status 2; nothing is guessed. [`config.example.toml`](config.example.toml) is annotated.

| Setting | Rule |
| --- | --- |
| `device.mode` | `companion` or `console`. Required. Never auto-detected. |
| `device.select` | Exactly one of: `path`, an explicit `/dev/...` path, normally a udev-provided stable symlink such as `/dev/bench/<name>`; a `/dev/serial/by-id` name pattern (`by_id`); or `vid` and `pid` (and optionally `usb_serial`). A raw kernel node (`/dev/ttyUSB0`, `/dev/ttyACM0`, `/dev/ttyS0`, `/dev/ttyAMA0`, `/dev/cu.*`), a path with a wildcard or `..`, or `*` is refused. A selector that matches two ports is refused, not guessed. `--port <path>` on the command line replaces the configured selector with `path` (same validation), so a bench run names its port explicitly. A `path` that does not exist yet, or is not a character device, is polled like an absent stable id. |
| `mqtt.client_id` | Required, from the broker login. Never generated. |
| `mqtt.topic_root` | Required. `mecon/<device_id>`: the device's own 16-byte id as 32 lowercase hex digits (from `hello` or `deployment.get`), as provisioned for its broker login. The Connector never reads it from the device. |
| `mqtt.topics` | Optional suffixes under the root: `resp` (default `resp`), `ev` (the prefix of event topics, default `ev`), `req` (default `req`), `status` (default `status`). They must differ and not nest. The defaults are the Backend's mapping. |
| `mqtt.brokers` | One to six. First is primary, the rest are fallbacks. TLS with peer and host-name verification is the default; plain MQTT needs `insecure_allow_plain = true` and is for loopback or a closed test LAN. |
| `*.password_file` | A file read when connecting. The value is never in the config, the logs or the metrics. Mode 600. A file that cannot be read at startup is a configuration error: one line naming the path, exit status 2. `--check-config` does the same for a file that exists but cannot be read; for an absent file it only prints a note, because installers and CI run it where a systemd or container credential is not yet present. One that becomes unreadable later is a failed connect attempt (counted as `auth`, logged, retried after the long auth back-off), never a crash. |
| `downlink.gate` | Optional timings for the enrolment gate (below). There is no switch to turn downlink on: it opens only for an enrolled device. |

## Hold transport (recommended for a standing Connector)

A Connector can hold its device over a Backend's WebSocket instead of an MQTT broker. This is the same hold a browser app uses to carry a device it has attached, specified as a public contract in [`contracts/connector-hold/v1`](../contracts/connector-hold/v1/README.md) so any Backend can offer it. It needs one thing from the Backend: a long-lived, device-scoped, revocable **connector token**. No broker, no broker account and no broker password sit on the Connector host. MQTT stays as the other transport: `transport = "mqtt"` is the default and nothing in that mode changes.

**Status: implemented against the contract and a fake Backend endpoint** (a real WebSocket on loopback, with the fake serial device). It has not been run against a live Backend or a real device yet.

```toml
transport = "hold"

[device]
mode = "companion"
select = { by_id = "usb-REPLACE_WITH_YOUR_DEVICE_ID-*" }

[hold]
base_url = "https://backend.example.invalid"
token_file = "/run/credentials/mecon-connector.service/hold-token"
```

[`deploy/config.hold.example.toml`](deploy/config.hold.example.toml) is the annotated file. With systemd the token is handed to the service as a credential, exactly like the broker password in MQTT mode. Install the drop-in [`deploy/systemd/mecon-connector-hold.conf.example`](deploy/systemd/mecon-connector-hold.conf.example), which clears the packaged unit's broker-password credential and loads the token instead:

```sh
sudo install -m 0600 -o root -g root /dev/null /etc/mecon-connector/credentials/hold-token
sudoedit /etc/mecon-connector/credentials/hold-token    # the token and nothing else; check the mode is still 0600
sudo install -D -m 0644 deploy/systemd/mecon-connector-hold.conf.example /etc/systemd/system/mecon-connector.service.d/hold.conf
sudo install -m 0640 -o root -g mecon-connector deploy/config.hold.example.toml /etc/mecon-connector/config.toml   # then edit it
sudo -u mecon-connector /opt/mecon-connector/bin/mecon-connector --check-config --config /etc/mecon-connector/config.toml
sudo systemctl daemon-reload && sudo systemctl enable --now mecon-connector
```

(`install.sh --enable` is for the MQTT transport: it requires a broker password. For a hold, install without `--enable`, then do the steps above.)

| Setting | Rule |
| --- | --- |
| `transport` | `mqtt` (default) or `hold`. A `[hold]` table needs `transport = "hold"`, and `[mqtt]` is refused with it, so nothing is silently ignored. |
| `hold.base_url` | Required. `https://host[:port][/prefix]` (or `wss://`); the Connector adds `/gateway/ws`. No credentials, query or fragment. Plain `http://` or `ws://` is refused unless `insecure_allow_plain = true` (loopback or a closed test LAN only); that flag is meaningless with TLS and refused there. TLS verifies the peer and host name; `ca_file` names a private CA. |
| `hold.token_file` | Required, an absolute path. Read each time a connection starts; the value is never in the config, the logs, the metrics, an exception text or the URL. Refused when any user can read it (mode bit `o+r`); group access is allowed so a root-owned 0640 file works, and a systemd credential is 0400. An unreadable file at startup is a configuration error (exit 2; `--check-config` only notes an absent one). One that becomes unreadable later is a failed attempt, retried on the backoff. |
| `hold.token_presentation` | `header` (default): `Authorization: Bearer <token>`. `subprotocol`: offers `mecon-bridge` and `bearer.<token>`, for a path where a proxy strips the header. The token is never put in the query string. |
| `hold.request_timeout_s` | 15 (2-30). How long one relayed request may wait for the device before it is abandoned. |
| `hold.ping_interval_s` | 20 (0 or 5-120). WebSocket control pings, so a dead path is noticed. |
| `hold.connect_timeout_s` | 10 (1-60). |
| `dfu.enabled` | `false` (default). `true` turns on bootloader serial DFU (below); it needs `transport = "hold"` and `dfu.bootloader`. |
| `dfu.bootloader` | The bootloader's own port: `path`, `by_id`, or `vid` and `pid` (with optional `usb_serial`), validated like `device.select` (a kernel node such as `/dev/ttyACM0` is refused). It must not be the same selector as `device.select`, and the two must not overlap: a `device.select` that could also match the bootloader's port (a broad `by_id` pattern, say) would open it as the device while a failed job waits. The check compares selectors literally, so prefer `vid`/`pid` or an exact name for both. |
| `dfu.bootloader_wait_s`, `dfu.app_return_wait_s`, `dfu.arm_window_s` | 30 (5-300), 120 (10-900), 60 (10-600). |
| `dfu.attempts` | 3 (1-10). Transfer attempts before the job is reported failed. |
| `dfu.package_max_bytes` | 2 MiB (64 KiB-16 MiB). A larger package is refused before it is fetched or used. |

**What it does.**

- It opens the socket only when the device link is up, the device has answered the Connector's own unsigned `hello`, and the enrolment gate (below) is open. Right after every connect it sends `iface_relay`, then `iface_hello` carrying the hello result object. The hello is read again after a device reboot and sent again.
- It relays each `iface_req` `wire` to the device byte for byte in the active framing (`0x7F` frames of at most 168 bytes for a Companion, up to 4,096 bytes; for a console one bare CR per link, then `mecon> ` + wire + CR, no CR or LF in the wire). The wire is never parsed, re-serialised, signed or given an `auth`.
- **One request at a time**, with a wait for the device (15 s) and then it is abandoned, never written again. A request that arrives while another is in flight waits in a short queue (at most `queues.downlink_max_messages`, each at most `queues.downlink_ttl_s`), and is dropped and counted if it waits too long; the Backend resends. A request whose `id` is already in flight is ignored.
- A device message that answers a relayed `id` goes up as `iface_result`, and an event as `iface_event` with `stream` = its `ev`, both with the device's exact text. An `ev` that does not match `^[a-z][a-z_]{0,31}$`, or is `result`, is dropped and counted. The Connector's own `hello` and `deployment.get` and their answers are consumed, never uploaded. Nothing is queued while the socket is down: the message is dropped and counted.
- `iface_ack` outcomes are counted. An outcome starting `refused` means the Backend recorded nothing: counted and never resent. `duplicate` is success.
- **Reconnect** on 1, 2, 4, 8, then 15 s, and `iface_relay` again each time. The hold is closed with 1000 when the device link drops and when the Connector stops.
- **A stop is not a retry.** A `refused` frame (another agent holds the device, or the token was revoked) and a close 1008 or an HTTP 401 or 403 on the handshake without one (a token the Backend does not accept) stop the hold. The Connector logs the reason, reports it in `/healthz` (`"hold": "stopped"`, `hold_stop`, `hold_stop_detail`) and exits with status **3**, which the unit lists in `RestartPreventExitStatus` so systemd does not loop on it. The operator fixes the cause (a second agent, a revoked or mistyped token) and restarts the service.
- Frames of unknown type, invalid JSON and binary frames from the Backend are ignored and counted; the socket stays open.

**Bootloader serial DFU (optional).** A board whose update is installed by its bootloader resets into that bootloader after it accepts the offer, and needs the package sent over USB serial. With `[dfu] enabled = true` the Connector does that itself, as section 12 of the hold contract says:

- It adds `"serial_dfu": true` to `iface_relay`; without `[dfu]` the frame and the behaviour are exactly as before, and a `dfu_job` from the Backend is ignored and counted.
- A `dfu_job` on the live socket arms it for that one job. It sends `dfu_state` `fetching`, fetches `{base}/gateway/dfu-package/{job}` at once with the hold token as `Authorization: Bearer` (same TLS settings, no proxy, no redirect), checks the length and SHA-256 against the job before using a byte, and keeps the package in memory only, until the transfer ends. A refusal or a mismatch is `failed` and the device is never touched.
- If the application port drops within 60 s of the job, the socket is kept (the only case where it is), nothing is relayed (requests are dropped and counted as with a closed gate), and the Connector looks for the bootloader's port for 30 s. Only then, and only for an armed job, does it open that port, exclusively, and send the package: legacy Nordic serial DFU as `adafruit-nrfutil` sends it (HCI packets in SLIP frames at 115200 baud: start, init, 512-byte data packets, stop, each acknowledged), in `nordic_dfu.py`. A failed attempt is retried with a fresh start, 3 attempts in all.
- After the transfer it waits up to 120 s for the application port, then takes the normal path on the same socket: hello, the enrolment gate, `iface_relay` and `iface_hello`. The device's hello carries the attestation the Backend confirms the job from.
- Every step is reported as `dfu_state` (`waiting-bootloader`, `transferring`, `rebooting`, `installed-pending-hello`, or `failed` with a stage and an error code). After `failed` the socket is kept without relaying; the Connector resumes when the application port returns, and runs again on a new `dfu_job` for the same job.
- `/healthz` shows `"dfu": "<phase>"` while a job is armed or running. Metrics: `hold_dfu_active` (1 while a DFU keeps the hold without a device link), `hold_dfu_states_total{state}`, `hold_dfu_transfer_attempts_total{result}`.

The systemd unit's `DeviceAllow` already covers `ttyACM` and `ttyUSB`; give the bootloader port a udev rule of its own if you select it by path (see the udev template).

**The enrolment gate in hold mode.** The gate is kept, with the same meaning: relayed requests are written to the device only while the device answers `deployment.get` with `provisioned`; it closes at once on the first uplink interface message without `usig`, on a new epoch, and when the link is lost; closed means requests are refused and counted, never held. Two things differ because a hold is one socket and not a topic: the socket is not opened until the gate has opened, and a gate that stays closed after the device has answered "not enrolled" (or has not answered) releases the hold with 1000 so the Backend routes elsewhere; a gate that is only re-asking (after an unsigned message or a new epoch) keeps the socket. The Backend signing its requests does not make the gate redundant: a signature protects a request in transit from the Backend, not the device from an unsigned first-provisioning or reset message arriving over the cable, and the Connector cannot tell either from the other without reading `wire`, which it never does. The gate also keeps the transports behaving alike. First enrolment of a device stays a hand-on-cable act.

**Exit status.** 0 a clean stop; 2 a configuration error; 3 a stopped hold. Hold-specific metrics (all under `mecon_connector_`): `hold_connected`, `hold_stopped`, `hold_connect_attempts_total{result}`, `hold_disconnects_total`, `hold_relay_declared_total`, `hold_uploads_total{kind}`, `hold_acks_total{outcome}`, `hold_uploads_uncertain_total` (uploads whose session ended before their ack arrived: the Backend may or may not have them, and they are never resent, so `hold_uploads_total` = acks + uncertain once the hold is down), `hold_request_timeouts_total`, `hold_frames_ignored_total{reason}`, `hold_hello_total{result}`, beside the serial, gate and `downlink_*` counters it shares with the MQTT transport (`downlink_*` there means requests relayed to the device). Hold mode has no broker series. `ready` in `/healthz` means the serial port is open and the hold is connected.

## The enrolment gate (MQTT transport)

The firmware treats a USB cable caller as local, and a device with no Deployment record accepts unsigned requests from it, including first provisioning and resets. Anything the Connector wrote from the broker would arrive as that caller. So broker messages reach the device **only while the device itself says it is enrolled**; an unenrolled device gets uplink only. The state is never taken from configuration.

- **How it asks.** The Connector sends the device `{"v":1,"id":"cg-<n>","op":"deployment.get"}`, an unsigned read, in the active framing (`0x7F` frames in `companion` mode, one `mecon> ` line in `console` mode). Downlink opens only when the answer is `status` `ok` with `result.state` `"provisioned"`. `none`, `corrupt`, a `refused`, an answer that does not parse, no answer within 8 s, or anything else means closed.
- **When.** When the serial port opens, when a broker session is (re)established, on a new `epoch` (a reboot), every 10 minutes while open, and every 30 s while closed. The two intervals and the timeout are `downlink.gate` settings with bounds (they apply to the hold transport too).
- **Close at once.** While a record exists, every interface event and result carries `usig`. The first uplink interface message without it closes downlink immediately (that is what follows a `deployment.reset`), the message is still forwarded unchanged, and downlink reopens only after a fresh `deployment.get` says `provisioned`.
- **What it reads.** Only its own reply (matched by the reserved id prefix `cg-`), whether a top-level `usig` member is present, and an epoch (`epoch`, `result.epoch` or `usig_boot`). Uplink is never altered and always forwarded, except the device's answer to the Connector's own request, which is the Connector's traffic: neither the request nor its answer is published upstream.
- **While closed,** broker messages are dropped and counted (`downlink_closed_total`), never held and never replayed after the gate reopens.
- **When open,** the Connector is a plain bridge: it does not check signatures or operations on relayed content. For an enrolled device the firmware requires a member's signature for everything but reads, and unsigned reads are relayed by decision. Restrict who may publish to `down` with the broker ACL anyway.
- **One request at a time.** The firmware handles one interface message at a time, so the Connector's request can interleave with a Backend request in flight; the Backend re-sends with the same id on a `busy` answer.
- **Native Companion frames** are not interface messages: they stay dropped and counted, uplink and downlink.

## What it does

Serial to broker:

- `companion` mode reads the `>` wrapper (marker, 16-bit length, at most 176 bytes), resynchronises on garbage, refuses an oversize length at once, and reassembles `0x7F` interface frames (up to 25 frames, 4096 bytes) into one message. Native Companion frames are counted and not forwarded.
- `console` mode reads `mecon> {` lines (at most 1600 bytes of message after the prefix, so 1607 with it, CR or LF terminated) and skips echo and log lines without buffering them.
- Each complete message becomes one MQTT publish of exactly those bytes, QoS 1 (configurable to 0), not retained. The Connector parses the message only to choose the **topic**: an `ev` member that is a safe name (`A-Za-z0-9_-`, 1 to 32 characters) goes to `<root>/ev/<ev>`; otherwise an `id` that is a non-empty string or an integer goes to `<root>/resp`. A message with neither (or an unsafe `ev`, never falling back to `resp`) has no route and is dropped and counted (`upstream_dropped_total{reason="unroutable"}`). The bytes are never altered, re-serialised or signed: the device's own `usig` signature must still verify at the Backend.

Broker to serial (only while the gate is open): each message on `<root>/req` is wrapped (`0x7F` frames in `<` wrappers, or one `mecon> ` line) and written once. Retained messages are refused. An empty, oversize or (console) line-breaking message is dropped and counted, never rewritten.

On shutdown the Connector releases the device explicitly: it publishes the status `{"online":false}` and closes the broker session before it exits.

The Connector also publishes a retained status message on `<root>/status` (QoS 0), exactly `{"online":true}` or `{"online":false}`, with the same `{"online":false}` as its last will. `online` is true only while the broker session is up and the serial port is open. It is the Connector's own state, never the device's identity, health, enrolment or radio presence; the serial state alone is in `/healthz` and `/metrics`.

## Delivery rules, in one table

| Situation | What happens |
| --- | --- |
| Broker down | Envelopes wait in a bounded queue (64 messages, 256 KiB, 60 s). On reconnect they go out once, in order. This is their first send. |
| Publish handed over, session ends before the PUBACK | Counted as `upstream_uncertain_total` and **never resent**. The broker may already hold it. A new session uses a new MQTT client object, so the library has nothing to replay. |
| Queue full | The newest envelope is dropped and counted. Nothing is dropped without a metric. |
| Command arrives while the enrolment gate is closed (unenrolled, unknown, serial unplugged, after an unsigned uplink or a reboot) | Dropped and counted as `downlink_closed_total`. Not held, not replayed when the gate reopens. |
| Command waited more than 5 s | Dropped and counted. |
| Serial write fails | Counted. Never retried: the device may have seen all, part or none of it. |
| Broker drops and reconnects | No command is written a second time. Downlink is subscribed at QoS 0 on a clean session, retained messages are refused, and the gate closes at every broker reconnect and asks again. |

If the sender needs a result it re-sends with the same request `id` and reads the answer; the firmware's id cache makes that safe for state-changing operations. The Connector never does this for it.

Reconnect uses exponential backoff with jitter (1 s doubling to 60 s), a long cool-down (60 s doubling to 1 h) after a refused login or a certificate that does not verify, fallback to the next broker, and a return to a better broker only after a 60 s hold-down. It never falls back to plain MQTT.

**Returning to a better broker is make-before-break.** While on a backup, once the hold-down has passed and a better broker's backoff has expired, the Connector probes it: a separate, short-lived MQTT connection with its own client id (`<client_id>-probe`, never the live one, which would take the working session over), a clean session, the same TLS and login, bounded by `connect_timeout_s`, that never publishes or subscribes and is closed at once. The probe runs off the main loop, so serial reading is not paused. A failed probe counts as a failed attempt on that broker (its backoff grows with its failure count) and is counted as `mecon_connector_broker_connect_attempts_total{result="probe"}`; the working session, the retained status, the in-flight publishes and the downlink gate are untouched, so a dead primary costs no gap, no `upstream_uncertain_total` and no status flap. A successful probe starts the switch: no new upstream publish is taken (they wait in the queue), in-flight publishes get up to 5 s to be acknowledged, then the session ends and the better broker is connected; anything still unacknowledged at 5 s is counted `upstream_uncertain_total` and never resent, as before. The switch still ends with a real reconnect, so the downlink gate closes and re-asks the device as on any reconnect.

## Health and metrics

`GET http://127.0.0.1:9464/healthz` returns JSON and status 200 when the serial port is open and a broker session is up, otherwise 503. `GET /metrics` returns Prometheus text with the `mecon_connector_` prefix; the names are fixed by the contract. `ready` says only that the two transport links are up. Logs are one JSON object per line on stderr and never contain payloads, credentials or packet dumps.

## Install on a Pi or Debian

For Raspberry Pi OS (Bookworm, 64-bit Lite is enough) and Debian 12 or newer: a systemd service in a virtualenv, running as its own unprivileged user. Needs `python3` 3.11+ and `python3-venv` (`sudo apt-get install -y python3 python3-venv git`).

```sh
git clone https://github.com/hoejriis/mecon-backend.git && cd mecon-backend     # check out the release you want
sudo connector/deploy/install.sh
```

The script is idempotent and fails closed (`set -euo pipefail`, refuses anyone but root, prints no secret). It:

- creates the system user and group `mecon-connector` (no login, no home); the service gets the serial device through the supplementary group `dialout`;
- builds `/opt/mecon-connector` (a venv) from the hash-pinned `requirements.lock` and `deploy/build-requirements.lock`, so nothing is downloaded unverified, owned by root;
- installs `/etc/systemd/system/mecon-connector.service` and the udev template `/etc/udev/rules.d/99-mecon-connector.rules` (inert until you fill it in);
- creates `/etc/mecon-connector` (`root:mecon-connector` 0750) and `credentials/` (root 0700), and installs an example `config.toml` (`root:mecon-connector` 0640) **only if none exists**. An existing config is never overwritten, re-owned or re-moded.
- does **not** start the service: the example config has placeholders.

Then, by hand:

1. **Find the radio's stable id** and write it into `/etc/mecon-connector/config.toml` (`device.select`): `/opt/mecon-connector/bin/mecon-connector --list-ports` prints `by_id` names and `vid`/`pid`/`usb_serial`. Set `mqtt.client_id`, `mqtt.topic_root` and the broker (the values come from whoever runs the broker; see the contract).
2. **Put the broker password** in a root-only file, never in the config: `sudo sh -c 'umask 077; cat > /etc/mecon-connector/credentials/broker-password'` (type or paste, end with Ctrl-D). systemd hands it to the service through `LoadCredential=`; it appears only under `/run/credentials/mecon-connector.service/`, which is where `password_file` in the shipped config points. The file is required: the unit does not start without it. For a broker without a password, create it empty and drop `username` and `password_file`.
3. **Broker CA:** `sudo install -o root -g mecon-connector -m 0640 ca.pem /etc/mecon-connector/ca.pem`.
4. **udev (once):** edit `/etc/udev/rules.d/99-mecon-connector.rules` as its comments say, then `sudo udevadm control --reload && sudo udevadm trigger --subsystem-match=tty`. It sets group `dialout`, mode 0660, a fixed `/dev/mecon/connector-radio` symlink and tells ModemManager to leave the port alone. The ids in the rule are the same ones as in `device.select`. The repository ships no real ids.
5. **Check and start:**
   ```sh
   sudo -u mecon-connector /opt/mecon-connector/bin/mecon-connector --check-config --config /etc/mecon-connector/config.toml
   sudo systemctl enable --now mecon-connector
   systemctl status mecon-connector; journalctl -u mecon-connector -f
   curl -s http://127.0.0.1:9464/healthz
   ```
   `install.sh --enable` does 5 for you, and refuses while the config still has placeholders or the credential file is missing.

### What the unit enforces

`deploy/systemd/mecon-connector.service`: a fixed non-root user and `SupplementaryGroups=dialout`; `NoNewPrivileges`, an empty `CapabilityBoundingSet`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, kernel, cgroup and clock protection, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, a syscall filter, `DevicePolicy=closed` with only `ttyACM` and `ttyUSB` allowed; the only writable path is `/var/lib/mecon-connector`; `MemoryHigh=128M`, `MemoryMax=192M` and `TasksMax=64` for a 512 MB board; `Restart=on-failure` after 10 s with no start limit, and **no restart on exit status 2** (a configuration error would only loop). `systemd-analyze security` scores it well under 3 (CI gates at 3.0). A `systemd` older than 254 (Bookworm has 252) has no `RestartSteps`; on 254 or newer a drop-in with `RestartSteps=5` and `RestartMaxDelaySec=120` gives a growing delay. Do not edit the unit; use `systemctl edit mecon-connector` (an upgrade replaces the unit file, never a drop-in).

**Shutdown.** `systemctl stop` sends SIGTERM; the Connector publishes the retained status `offline`, closes the broker session and the port, and exits 0, in about half a second (`tests/test_shutdown_signal.py` bounds it to a third of `TimeoutStopSec=15`; systemd sends SIGKILL after that).

**Secrets.** The password is a root 0600 file loaded with `LoadCredential=`; the unit and the process environment never hold it (a static test and the install test both look for it). Nothing in the scripts reads or prints it.

## Container

`deploy/docker-compose.example.yml` is the container equivalent: non-root user 10001, read-only root filesystem, all capabilities dropped, `no-new-privileges`, the device passed with `devices:` by its `/dev/serial/by-id` path, the broker password as a compose secret (host file mode 0400, owned by uid 10001), the config mounted read-only, a `/healthz` healthcheck, 192 MB and 64 pids. Copy it, set the device name, `SERIAL_GID` (`stat -c %g /dev/ttyACM0`) and the files it lists, then `docker compose up -d --build`. In config.toml use `password_file = "/run/secrets/broker-password"`. Docker does not honour `uid` or `mode` on file secrets, which is why the host file itself carries them.

## Upgrade

```sh
cd mecon-backend && git pull        # or check out the release tag
sudo connector/deploy/install.sh    # rebuilds the venv from the locks, replaces the unit, keeps config, credentials and the udev rule
```

The venv is rebuilt in place; if the build fails the previous one is put back. A running service is restarted onto the new version after a successful install; a stopped one stays stopped. Read the release notes for a config or contract change first: the config is yours and is never rewritten.

## Uninstall

```sh
sudo connector/deploy/uninstall.sh            # stops and removes the service, unit, udev rule and venv; keeps config, credentials, state and the user
sudo connector/deploy/uninstall.sh --purge    # also removes /etc/mecon-connector, /var/lib/mecon-connector and the user and group
```

## Troubleshooting (dialout, by-id, apparmor)

| Symptom | Cause and fix |
| --- | --- |
| `serial_unavailable` in the journal, `/healthz` `serial: down` | No port matches `device.select`. `mecon-connector --list-ports` shows what the host sees; the by-id name changes with the interface (`-if00`) and with the radio's firmware. A radio with no USB serial number gets a by-id name without one: select by `vid` and `pid`. |
| `Permission denied` opening `/dev/ttyACM0` | The service user is not in the device's group. On Debian and Pi OS the group is `dialout`, which the unit adds with `SupplementaryGroups=`; check `ls -l /dev/ttyACM0` and, if your distribution uses another group (`uucp` on Arch), add a drop-in `SupplementaryGroups=uucp`. A container needs `--group-add` with the numeric gid. |
| `/dev/serial/by-id` is empty or missing | udev has not made the links yet, or the board has no serial descriptor. `udevadm info -a -n /dev/ttyACM0`; replug; check `ls /dev/serial/by-id`. A hub or a power-starved port can drop the device repeatedly: look at `dmesg -w`. |
| The radio resets or answers garbage right after plugging in | ModemManager probes new serial ports. The udev rule's `ID_MM_DEVICE_IGNORE` stops that; or `sudo systemctl disable --now ModemManager`. Also, opening the port can reset an ESP32-S3 board and an nRF52 bridge may need DTR (see "What is not verified"). |
| `Failed to start ... credential` or `Permission denied: /run/credentials/...` | The source file `/etc/mecon-connector/credentials/broker-password` is missing, or the unit was edited and lost `LoadCredential=`. It must be root-owned; the service sees its own copy. |
| Exit status 2, service not restarted | A configuration error. `journalctl -u mecon-connector` lists every problem; fix it and `systemctl restart mecon-connector`. |
| Killed with `Memory cgroup out of memory` | Hit `MemoryMax=192M`. Report it with `/metrics`; the expected size is about 25 to 30 MB. |
| mosquitto exits at once on Ubuntu when started with a config under `/tmp` (tests, `measure.py`) | The distribution's AppArmor profile confines `/usr/sbin/mosquitto` to system paths. `sudo apparmor_parser -R /etc/apparmor.d/usr.sbin.mosquitto` (the profile may be named `mosquitto`) unloads it until reboot. It does not affect the Connector's own unit. |
| `systemd-analyze verify` says the user or the binary does not exist | It checks the paths on the machine it runs on; run it after `install.sh`. |

## Measurements

`scripts/measure.py` runs the real bridge and MQTT client against a fake serial device and a local mosquitto for N seconds and writes a JSON report: resident memory (and the bare interpreter for comparison), CPU, three broker restarts with the time to reconnect, upstream latency p50 and p95 (steady state, and around the outages), delivery counts, and the time of a clean shutdown. CI runs it for 60 s on GitHub's arm64 and amd64 runners and uploads `measure-report.json` as an artifact. **Those numbers are labelled "runner, not a Pi" and say nothing about a Pi Zero 2 W.** A runner is faster, has gigabytes of memory and no SD card, and the fake serial device removes the UART, so USB throughput and byte loss are not measured either. The reconnect time is the Connector's backoff (1 s doubling to 60 s), so it is dominated by when the next retry happens to fall after the broker returns.

```sh
python3 -m venv .venv && . .venv/bin/activate && pip install --require-hashes --no-deps -r requirements.lock
python scripts/measure.py --seconds 60 --out report.json      # needs mosquitto on PATH and Linux
```

### Pooled owner step for C2 on a real Pi Zero 2 W

One sitting, about 20 minutes, no radio and no broker account needed (the checks use a throwaway local broker and a synthetic credential). On a Pi Zero 2 W running Raspberry Pi OS Lite 64-bit (Bookworm), with network access, over SSH:

```sh
sudo apt-get update && sudo apt-get install -y --no-install-recommends git python3 python3-venv mosquitto mosquitto-clients
sudo systemctl disable --now mosquitto
git clone https://github.com/hoejriis/mecon-backend.git && cd mecon-backend
git checkout <the commit or tag named on the Issue>      # git rev-parse HEAD must match it
# 1. memory, CPU, reconnect and latency on the Pi (10 minutes)
python3 -m venv /tmp/m && /tmp/m/bin/pip install --require-hashes --no-deps -r connector/requirements.lock
/tmp/m/bin/python connector/scripts/measure.py --seconds 600 --label "Raspberry Pi Zero 2 W" --out "$HOME/measure-pi.json"
# 2. the systemd unit under the real sandbox, install, start, stop, uninstall (about 2 minutes; leaves the Pi as it was)
sudo connector/deploy/smoke-systemd.sh 2>&1 | tee "$HOME/smoke-pi.txt"
# 3. facts about the machine
{ cat /proc/device-tree/model; echo; uname -a; systemctl --version | head -1; free -m; vcgencmd get_throttled; vcgencmd measure_temp; git rev-parse HEAD; } 2>&1 | tee "$HOME/pi-facts.txt"
```

Paste back to Issue 21: the full contents of `measure-pi.json`, `smoke-pi.txt` and `pi-facts.txt` (`cat` them). They hold no secret: the credential in the smoke test is a synthetic constant that the script never prints. If `vcgencmd get_throttled` is not `0x0` the Pi was under-powered or too hot and the numbers are suspect; say so. If a check in step 2 fails, paste its output and `journalctl -u mecon-connector --no-pager | tail -50` as it is, and stop.

With a radio attached the same install covers stage C3; that is a separate step.

## Tests

```sh
cd connector
pip install --require-hashes --no-deps -r requirements-dev.lock
python -m pytest -q                 # unit tests; integration tests run when `mosquitto` is on PATH
python scripts/mutation.py          # breaks each transport-safety rule and checks a test fails
python scripts/mutation_deploy.py   # breaks the packaging rules (config overwrite, secrets, root...) in a copy; needs docker or a Debian root shell
sh deploy/test-install.sh           # inside a disposable Debian container as root: install, upgrade, uninstall checks
sh scripts/test-in-docker.sh        # from the repo root: the same image shape CI uses, mosquitto included
python scripts/gen_fixtures.py      # regenerates contracts/connector/v1/fixtures (stdlib only, independent of the code)
```

- `tests/fakes/fake_serial.py` replays fixtures with split, coalesced, garbage, oversize, unplug and replug, and stall faults. `tests/fakes/fake_broker.py` is an in-process broker that can die before or after receiving a publish, refuse a login, and publish a last will.
- Every fixture in `contracts/connector/v1/fixtures` runs through the real bridge at several chunkings.
- `tests/test_integration_mosquitto.py` runs the real bridge and the real MQTT client against mosquitto: round trip, retained status, last will after a dropped connection, broker restart without duplicates, failover, return to a recovered primary (probe first, no reconnect of the backup session while the primary is down), TLS and password, and fail-closed on a wrong CA or password.
- `tests/test_contract_matches_code.py` fails when the code and `mapping.json` disagree (metrics, limits, defaults, topic templates).
- `tests/test_routing_and_port.py` covers routing, the status payload and will, the ACL-shaped topic set, and explicit port selection; `tests/test_c3_harness.py` the stand-in's refusal to publish anything but two read requests and the observer's no-content rule. The C3 bench harness is described in [`scripts/c3_bench.md`](scripts/c3_bench.md); `sh scripts/c3_fake_e2e.sh` runs it end to end with the fake device.
- `tests/test_nordic_dfu.py` checks the serial DFU codec against hand-computed vectors and the CRC check value, the package reader and check, the package fetch against the fake endpoint, and the transfer against `tests/fakes/fake_bootloader.py` (a bootloader written independently of the codec: it checks every frame, the sequence numbers and the packet order, and can lose acks, repeat a stale ack, add noise, stay silent or vanish). `tests/test_dfu.py` runs bootloader DFU end to end through the hold: declaration, package checks, the arming window, the kept socket, the transfer, retries, failure and the resume.
- `tests/test_hold.py` runs the hold transport against a fake Backend endpoint (a real WebSocket on loopback) and the fake serial device, one test per conformance item of the hold contract plus the token canary, the gate and the stop rules; `tests/test_hold_main.py` the hold configuration, exit status 3, `/healthz` and the unit's restart rule; `tests/test_hold_contract_fixtures.py` replays fixtures A-F of `contracts/connector-hold/v1` through the real bridge (for F, the exact bytes written to the fake bootloader). `python3 scripts/gen_hold_fixtures.py --check` fails if the fixture files drift from the generator.
- The mutation script breaks the transport and packaging rules, the hold's rules (`h1`-`h34`: the wire re-serialised, no `iface_relay` after a reconnect, a retry after `refused`, the token in a log line, the Connector's own probe answer uploaded, a second request before the first is answered, and others) and the serial DFU safety checks (`x1`-`x7`: the SHA-256 or size check removed, DFU entered on any link loss or after the arming window, the bootloader port opened without a job, `serial_dfu` declared when off, any acknowledgement taken as the right one), and requires a named test failure for each. The MQTT part breaks 60 rules (payload altered, in-doubt publish re-queued, a command written again after a reconnect, unbounded buffering, a duplicate publish on a repeated frame, silent drops and others) and requires a test failure for each.

## What is not verified

- The hold transport has run only against the contract's fixtures and an in-process fake endpoint (a real WebSocket on loopback, plain and with a synthetic CA) and the fake serial device. Not verified: any live Backend (the connector token kind, `iface_ack` outcomes and the exact `iface_hello` object a real Backend wants), a real device over the hold, how a real Backend or intermediary surfaces a rejected token (an HTTP 401 or 403, or a 1008 close; both stop the hold), idle timeouts through a real proxy,.

- Bootloader serial DFU has run only against a fake bootloader written from the protocol as `adafruit-nrfutil` sends it, and the fake package route. Not verified: a real bootloader's acknowledgements and timing, the USB identity it enumerates with, how long a real board takes to reset into it and back, and a live Backend's package route and `dfu_job`.
- Nothing has run with a real USB radio. Not verified: that a Companion's USB accepts `0x7F` frames on every build and before the app handshake, that boot text never precedes frames, that opening the port does not reset the board (an ESP32-S3 may reset on open, an nRF52 bridge may need DTR), and that 115200 baud is right for every board.
- Nothing has run against the Backend or its broker policy. The topic and ACL mapping is the Backend's as relayed by its coder on 2026-11-19; the Connector's routing (`id` to `resp`, `ev` to `ev/<ev>`) rests on the `ev` and `id` members that mapping names, and the real firmware's member names for responses and events are unverified until the C3 hardware run (the harness reports unroutable counts). Whether the Backend tolerates the status payload's `online` member alone, and a login with exactly the ACL in the contract, are unverified. The enrolment gate has run only against a fake device that models `deployment.get`, `epoch` and `usig` from the firmware docs; the real answers, the exact place of `epoch` in them, and whether an enrolled device accepts any unsigned read that returns data the Backend alone should see are unverified. Q4 in the contract is open (answered by the C3 hardware run); Q6 is answered.
- No Pi measurements: resident memory, CPU at sustained traffic, reconnect time, and behaviour under UART byte loss are unknown on a Pi. CI measures a runner (labelled as such); the Pi run is the pooled owner step under "Measurements".
- The systemd unit has run on a CI VM (Ubuntu, systemd 255) and, by hand, on Debian 12 (systemd 252) in a container; not on a Pi, and not with a real serial device, so `DeviceAllow` for `ttyACM` and `ttyUSB` and the `dialout` group on a real radio are untested. `LoadCredential=` did not populate in a nested-container test environment (a container limitation, not seen on a VM); the CI VM run is the evidence.
- The TLS check was exercised against a synthetic CA and mosquitto 2.0.x only. Failure classification between a certificate failure and a plain network failure depends on paho's log text and is best effort; both fail closed.
- Hot-unplug on Linux is covered by a fake device. The real error codes from a vanished USB serial port were not observed.
- The multi-arch image builds for arm64 under emulation in CI only; it has not been run on arm hardware.
