# C3 bench run: a real device, the Connector, a local broker

Stage C3 of the [implementation design](../../docs/USB_CONNECTOR_IMPLEMENTATION_DESIGN.md): the Connector with a real public-firmware device on a USB port, against a broker whose login has exactly the ACL the Backend gives a device. This page is the procedure and its pass/fail list. The helper scripts live next to it in `connector/scripts/`.

**What it exercises.** The enrolment gate against the device's real `deployment.get`, `epoch` and `usig`; the routing of real answers and events to `resp` and `ev/<name>`; the retained `{"online":...}` status with its last will; and two real read-only requests relayed to the device and answered.

**What it does not.** It is not the private Backend (a local broker stands in for the Backend's), it never sends a request that changes anything, and it cannot show that a non-read request is refused while the gate is closed on real hardware (the stand-in refuses to publish one; that item is proven against the fake device, see step 0).

Everything below uses made-up logins and a placeholder device id. Put your device's own id (32 lowercase hex digits, from its enrolment record) in `C3_DEVICE_ID`. No payload content is ever printed by these scripts; keep it that way when you paste output.

## Layout

```
laptop                                                         bench host
  Mosquitto (Docker, 127.0.0.1:18830)  <== reverse tunnel ==  127.0.0.1:18830
  password file + ACL                                            Connector (throwaway venv, foreground)
  observer, Backend stand-in                                       |  --port /dev/bench/<name>
                                                                 USB device
```

The broker listens on the laptop's loopback only. The tunnel opens a port on the bench host's loopback only. Nothing is installed as a service; the Connector runs in the foreground under `timeout` from a venv in `/tmp`.

## Placeholders

| Placeholder | Meaning |
| --- | --- |
| `<bench-host>` | An ssh destination (or `ssh_config` alias) for the bench host. Fill in. |
| `<port>` | The serial port as a stable path on the bench host, for example a udev symlink `/dev/bench/<name>`. A kernel node such as `/dev/ttyACM0` is refused by the Connector. Claim and name the port as your bench policy requires before step 5. |
| `<device_id>` | The device's id, 32 lowercase hex digits. The topic root is `mecon/<device_id>`. |
| `<login>` | The device login, `dev-<gateway_id>-g<generation>`. The default made-up value is `dev-gw0-g1`. |

```sh
export C3_DEVICE_ID=<device_id>          # laptop, every terminal
export C3_DIR=/tmp/mecon-c3-broker       # where the broker's files and secrets are (laptop)
```

## Step 0. Prove the harness locally (no hardware, no remote host)

```sh
sh connector/scripts/c3_fake_e2e.sh
```

This starts the Dockerized broker with the ACL, runs the real Connector against the fake serial device, drives it with the observer and the stand-in, and ends with `20/20 checks passed`. If it does not, do not go on.

## Step 1. Broker (laptop)

```sh
sh connector/scripts/c3_broker.sh up
```

Creates `$C3_DIR` (mode 700) with random passwords in `secrets/{connector,observer,standin}.pw` (mode 600, never printed), a Mosquitto password file, and this ACL, with your device id:

```
user dev-gw0-g1                      # the device login: publish only its own topics, read only requests
topic write mecon/<device_id>/resp
topic write mecon/<device_id>/status
topic write mecon/<device_id>/ev/+
topic read  mecon/<device_id>/req

user c3-observer                     # harness: read-only view of this device
topic read  mecon/<device_id>/#

user c3-standin                      # harness: may publish requests, nothing else
topic write mecon/<device_id>/req
```

Check: `sh connector/scripts/c3_broker.sh status` shows the container on `127.0.0.1:18830`.

## Step 2. Reverse tunnel (laptop, terminal 1)

```sh
C3_BENCH_HOST=<bench-host> sh connector/scripts/c3_tunnel.sh
```

Foreground, closes after `C3_MAX_SECONDS` (default 3600) or Ctrl-C. Leave it running.

## Step 3. Put the Connector on the bench host (laptop, terminal 2)

Only the source, the lock file and the run script go over; the password goes over stdin into a mode-600 file, never a command line.

```sh
ssh <bench-host> 'umask 077; mkdir -p /tmp/mecon-c3/connector'
tar -C connector -czf - src pyproject.toml requirements.lock scripts/c3_remote_run.sh \
  | ssh <bench-host> 'tar -xzf - -C /tmp/mecon-c3/connector'
ssh <bench-host> 'umask 077; cat > /tmp/mecon-c3/broker.pw' < "$C3_DIR/secrets/connector.pw"
```

## Step 4. Observer (laptop, terminal 2): start it before the Connector

It prints counts and envelope kinds only (topic class, size, retain flag, QoS, kind, whether `usig` is present, a short SHA-256 prefix) and ends with a pass/fail list.

```sh
python3 -m venv /tmp/c3-venv && /tmp/c3-venv/bin/pip install -q --require-hashes --no-deps -r connector/requirements.lock
/tmp/c3-venv/bin/python connector/scripts/c3_observer.py \
  --port 18830 --root "mecon/$C3_DEVICE_ID" --user c3-observer \
  --password-file "$C3_DIR/secrets/observer.pw" --duration 300 --expect-answers --min-events 1
```

## Step 5. Connector (bench host, foreground, bounded)

```sh
ssh -t <bench-host> 'C3_PORT=<port> C3_DEVICE_ID=<device_id> C3_USER=<login> C3_MAX_SECONDS=420 \
  sh /tmp/mecon-c3/connector/scripts/c3_remote_run.sh'
```

`c3_remote_run.sh` makes the venv under `/tmp/mecon-c3` on first run (needs PyPI), writes a config from the environment, runs `--check-config`, then runs the Connector in the foreground under `timeout` with `--port <port>` named on the command line. `C3_MODE=console` for a Repeater or Room console. Ctrl-C or the timeout stops it; it publishes `{"online":false}` and closes its session first.

Watch its log for `serial_connected`, `broker_connected`, then `downlink_open` (the gate opened) or `downlink_closed` with a reason.

## Step 6. Before the stand-in: the gate has opened and nothing was relayed to the device

On the bench host, in another shell:

```sh
ssh <bench-host> "curl -s http://127.0.0.1:9464/metrics | grep -E '^mecon_connector_(serial_connected|broker_connected|downlink_gate_open|downlink_gate_probes_total|downlink_received_total|downlink_written_total|downlink_closed_total|upstream_(envelopes|published|dropped)_total|serial_frames_total)'"
```

Expect `serial_connected 1`, `broker_connected 1`, `downlink_gate_open 1`, `downlink_gate_probes_total{result="provisioned"}` at least 1, and `downlink_received_total 0`, `downlink_written_total 0`, `downlink_closed_total 0`: the only thing written to the device so far is the Connector's own `deployment.get`. `upstream_dropped_total{reason="unroutable"}` must be 0.

## Step 7. Backend stand-in (laptop, terminal 3)

Publishes exactly two unsigned, read-only requests to `mecon/<device_id>/req`, QoS 0, not retained, three seconds apart: `hello` (id `c3-hello-1`) and `deployment.get` (id `c3-dg-1`). It refuses to build anything else.

```sh
/tmp/c3-venv/bin/python connector/scripts/c3_standin.py \
  --port 18830 --root "mecon/$C3_DEVICE_ID" --user c3-standin \
  --password-file "$C3_DIR/secrets/standin.pw"
```

## Step 8. After the stand-in: metrics again

Run the step 6 command again. Expect `downlink_received_total 2`, `downlink_written_total 2`, `downlink_closed_total 0`, and `upstream_published_total` equal to the number of response and event lines the observer printed (the Connector's own probe answers are not published), `upstream_dropped_total` all 0.

## Step 9. The last will (optional, 1 minute)

While the Connector runs, stop the tunnel (Ctrl-C in terminal 1). The broker publishes the will: the observer prints `status ... online=False` and a late subscriber is handed `{"online":false}`. Restart the tunnel; the Connector reconnects with backoff, re-reads `deployment.get`, and `online=True` returns. Then stop the Connector with Ctrl-C and see the clean `online=False`.

## Step 10. Clean up

```sh
ssh <bench-host> 'rm -rf /tmp/mecon-c3'        # the venv, config and the broker password copy
sh connector/scripts/c3_broker.sh clean        # laptop: container, network, files and secrets
```

Close the tunnel and release the port as your bench policy requires.

## Expected results and pass/fail

| # | Check | How you see it | Pass |
| --- | --- | --- | --- |
| 1 | The gate opens only on `provisioned` | Connector log `downlink_open`; metrics `downlink_gate_open 1` and `downlink_gate_probes_total{result="provisioned"}` at least 1. With a device whose state is `none` or `corrupt`, or one that does not answer, the log says `downlink_closed` and the probe counter has the other result. | open for an enrolled device, closed otherwise |
| 2 | Uplink frames arrive intact on the right topics | Observer lines: answers on `resp` (kind `response`), events on `ev/<name>` (kind `event:<name>`), no `MALFORMED` or `UNEXPECTED`; every one `usig=yes` for an enrolled device; `upstream_dropped_total{reason="unroutable"}` 0. Byte identity is shown by the Backend verifying the device's `usig`; this harness cannot compare against the wire (the fake-device run does, by SHA-256). | observer summary all PASS |
| 3 | Status is retained, with the will | Observer item "a subscriber that joins late is handed it with the retain flag set"; step 9 shows `online=False` when the tunnel drops and after a clean stop. Payload is exactly `{"online":true}` or `{"online":false}`. | yes |
| 4 | The two reads are answered on `resp` with their ids | Observer: `answered ids: ['c3-dg-1', 'c3-hello-1']`. | both |
| 5 | Nothing is relayed to the device before the gate opens | Step 6: `downlink_received_total`, `downlink_written_total` and `downlink_closed_total` all 0 while the gate is already open and nothing has been published; the Connector's own `deployment.get` is the only write. | yes |
| 6 | A non-read request is not relayed while the gate is closed | Not possible on the bench with this stand-in, by design. Proven against the fake device in step 0 (phase B): a `channel.put` and a `hello` published to `req` while the gate is closed are both refused and counted, `written=0`. | step 0 only |

Any FAIL that is not an environment problem is a finding for the contract, not something to patch around on the day. In particular:

- `unroutable` above 0 means the device's answers or events do not carry the `id` and `ev` members the Backend mapping names: report the member names the firmware actually uses (contract Q1 and the routing rule).
- The gate staying closed, or `downlink_gate_probes_total{result="timeout"}`, means the device did not answer `deployment.get` over the cable at open (contract Q4: whether a Companion accepts `0x7F` frames before the app handshake, or whether boot text precedes frames). Note exactly what the device did and answer Q4.
- `serial_connected 0` repeatedly with `serial_reconnects_total` rising: the board resets on open (an ESP32-S3 may; an nRF52 bridge may need DTR). Note which.

## What this run does not verify

- The private Backend itself: its parsing of the status payload, its ACL provisioning, its request signing. The stand-in's requests are unsigned reads.
- That the device id in the topic root is the connected device's: the scripts never print payload content, so confirm `<device_id>` from the enrolment record.
- Byte identity on real hardware against the wire, and a non-read request refused on a closed gate on real hardware.
- Behaviour on a Pi, or over a real unplug (a separate bench step).
