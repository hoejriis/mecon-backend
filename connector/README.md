# MECON USB Connector

A small headless service that carries messages between a MECON public-firmware radio on a USB serial port and an MQTT broker. It is transport only.

```
USB radio  <-- serial framing -->  Connector  <-- MQTT 3.1.1 / TLS -->  broker  <-->  Backend
```

**What it does not do.** It never mints or substitutes identity, holds keys, decrypts, parses or rewrites a payload, fabricates an acknowledgement, or chooses a route. A device-signed envelope leaves exactly as it arrived. MQTT accepting a message is not RF delivery and not Backend processing, and the Connector never reports it as either.

**Status: stages C0 and C1 of the [implementation design](../docs/USB_CONNECTOR_IMPLEMENTATION_DESIGN.md).** It passes its unit tests, fake-device tests and a real-mosquitto integration test. It has not been run on a real device, a Pi, or against the Backend. See [What is not verified](#what-is-not-verified).

The wire contract (frames, topics, QoS, retry rules, metrics) is in [`contracts/connector/v1`](../contracts/connector/v1/README.md). Its topic names are provisional: the Backend owns the real mapping.

## Language and runtime

Python 3.11 or newer, two pinned dependencies (`paho-mqtt`, `pyserial`), both pure Python. The design document names no language. Python was chosen for a 512 MB Pi Zero 2 W because:

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
| `device.select` | A `/dev/serial/by-id` name pattern, or `vid` and `pid` (and optionally `usb_serial`). A raw `/dev/ttyUSB0` path or `*` is refused. A selector that matches two ports is refused, not guessed. |
| `mqtt.client_id` | Required, from the broker login. Never generated. |
| `mqtt.topic_root` | Required. The topic root provisioned for this device. The Connector never reads it from the device. |
| `mqtt.brokers` | One to six. First is primary, the rest are fallbacks. TLS with peer and host-name verification is the default; plain MQTT needs `insecure_allow_plain = true` and is for loopback or a closed test LAN. |
| `*.password_file` | A file read when connecting. The value is never in the config, the logs or the metrics. Mode 600. |
| `downlink.enabled` | Required, no default. `false` makes the Connector upstream-only (it subscribes to nothing). See the warning below. |

**Downlink warning.** The firmware treats a USB cable caller as local, and a device that holds no Deployment record accepts unsigned cable requests, including first provisioning. Anything the Connector writes arrives as that caller. Enable `downlink` only for an enrolled device, and let only the Backend publish to the down topic (broker ACL). This is open question Q2 in the contract.

## What it does

Serial to broker:

- `companion` mode reads the `>` wrapper (marker, 16-bit length, at most 176 bytes), resynchronises on garbage, refuses an oversize length at once, and reassembles `0x7F` interface frames (up to 25 frames, 4096 bytes) into one message. Native Companion frames are counted and not forwarded.
- `console` mode reads `mecon> {` lines (at most 1600 bytes with the prefix, CR or LF terminated) and skips echo and log lines without buffering them.
- Each complete message becomes one MQTT publish of exactly those bytes, QoS 1, not retained.

Broker to serial (when enabled): each message on the down topic is wrapped (`0x7F` frames in `<` wrappers, or one `mecon> ` line) and written once. Retained messages are refused. An empty, oversize or (console) line-breaking message is dropped and counted, never rewritten.

The Connector also publishes a retained status message `{"v":1,"connector":"online|offline","serial":"up|down|unknown"}` with a last will. It is the Connector's own state, never the device's presence.

## Delivery rules, in one table

| Situation | What happens |
| --- | --- |
| Broker down | Envelopes wait in a bounded queue (64 messages, 256 KiB, 60 s). On reconnect they go out once, in order. This is their first send. |
| Publish handed over, session ends before the PUBACK | Counted as `upstream_uncertain_total` and **never resent**. The broker may already hold it. A new session uses a new MQTT client object, so the library has nothing to replay. |
| Queue full | The newest envelope is dropped and counted. Nothing is dropped without a metric. |
| Command arrives, serial is unplugged | Dropped and counted. It is not held for a replug. |
| Command waited more than 5 s | Dropped and counted. |
| Serial write fails | Counted. Never retried: the device may have seen all, part or none of it. |
| Broker drops and reconnects | No command is written a second time. Downlink is subscribed at QoS 0 on a clean session and retained messages are refused. |

If the sender needs a result it re-sends with the same request `id` and reads the answer; the firmware's id cache makes that safe for state-changing operations. The Connector never does this for it.

Reconnect uses exponential backoff with jitter (1 s doubling to 60 s), a long cool-down (60 s doubling to 1 h) after a refused login or a certificate that does not verify, fallback to the next broker, and a return to a better broker only after a 60 s hold-down. It never falls back to plain MQTT.

## Health and metrics

`GET http://127.0.0.1:9464/healthz` returns JSON and status 200 when the serial port is open and a broker session is up, otherwise 503. `GET /metrics` returns Prometheus text with the `mecon_connector_` prefix; the names are fixed by the contract. `ready` says only that the two transport links are up. Logs are one JSON object per line on stderr and never contain payloads, credentials or packet dumps.

## Deploying on a Pi Zero 2 W

Not yet verified on a Pi; this is the intended shape. Use Raspberry Pi OS Lite (64-bit), install Docker or a Python 3.11+ venv, put the config and secrets in `/etc/mecon-connector` (root-owned, secrets mode 600 and owned by the service user), and run the container above or this unit:

```ini
[Service]
User=mecon-connector
SupplementaryGroups=dialout
ExecStart=/opt/mecon-connector/bin/python -m mecon_connector --config /etc/mecon-connector/config.toml
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
DeviceAllow=char-ttyACM rw
DeviceAllow=char-ttyUSB rw
```

Packaging, udev rules, the unit and Pi measurements belong to stage C2.

## Tests

```sh
cd connector
pip install --require-hashes --no-deps -r requirements-dev.lock
python -m pytest -q                 # unit tests; integration tests run when `mosquitto` is on PATH
python scripts/mutation.py          # breaks each transport-safety rule and checks a test fails
sh scripts/test-in-docker.sh        # from the repo root: the same image shape CI uses, mosquitto included
python scripts/gen_fixtures.py      # regenerates contracts/connector/v1/fixtures (stdlib only, independent of the code)
```

- `tests/fakes/fake_serial.py` replays fixtures with split, coalesced, garbage, oversize, unplug and replug, and stall faults. `tests/fakes/fake_broker.py` is an in-process broker that can die before or after receiving a publish, refuse a login, and publish a last will.
- Every fixture in `contracts/connector/v1/fixtures` runs through the real bridge at several chunkings.
- `tests/test_integration_mosquitto.py` runs the real bridge and the real MQTT client against mosquitto: round trip, retained status, last will after a dropped connection, broker restart without duplicates, failover, TLS and password, and fail-closed on a wrong CA or password.
- `tests/test_contract_matches_code.py` fails when the code and `mapping.json` disagree (metrics, limits, defaults, topic templates).
- The mutation script breaks 18 rules (payload altered, in-doubt publish re-queued, a command written again after a reconnect, unbounded buffering, a duplicate publish on a repeated frame, silent drops and others) and requires a test failure for each.

## What is not verified

- Nothing has run with a real USB radio. Not verified: that a Companion's USB accepts `0x7F` frames on every build and before the app handshake, that boot text never precedes frames, that opening the port does not reset the board (an ESP32-S3 may reset on open, an nRF52 bridge may need DTR), and that 115200 baud is right for every board.
- Nothing has run against the Backend or its broker policy. Topic names, ACLs, the single up topic (the Connector cannot split responses from events without reading them), and the dual-transport arbitration are open (contract questions Q1 to Q6).
- No Pi measurements: resident memory, CPU at sustained traffic, reconnect time, and behaviour under UART byte loss are unknown.
- The TLS check was exercised against a synthetic CA and mosquitto 2.0.x only. Failure classification between a certificate failure and a plain network failure depends on paho's log text and is best effort; both fail closed.
- Hot-unplug on Linux is covered by a fake device. The real error codes from a vanished USB serial port were not observed.
- The multi-arch image builds for arm64 under emulation in CI only; it has not been run on arm hardware.
