# MECON USB Connector

A small headless service that carries messages between a MECON public-firmware radio on a USB serial port and an MQTT broker. It is transport only.

```
USB radio  <-- serial framing -->  Connector  <-- MQTT 3.1.1 / TLS -->  broker  <-->  Backend
```

**What it does not do.** It never mints or substitutes identity, holds keys, decrypts, parses or rewrites a payload, fabricates an acknowledgement, or chooses a route. A device-signed envelope leaves exactly as it arrived. MQTT accepting a message is not RF delivery and not Backend processing, and the Connector never reports it as either.

**Status: stages C0, C1 and the packaging of C2 of the [implementation design](../docs/USB_CONNECTOR_IMPLEMENTATION_DESIGN.md).** It passes its unit tests, fake-device tests and a real-mosquitto integration test; the install scripts run in a Debian container and the unit under real systemd on a CI VM. It has not been run on a real device, a Pi, or against the Backend. See [What is not verified](#what-is-not-verified).

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
| `*.password_file` | A file read when connecting. The value is never in the config, the logs or the metrics. Mode 600. A file that cannot be read at startup is a configuration error: one line naming the path, exit status 2. `--check-config` does the same for a file that exists but cannot be read; for an absent file it only prints a note, because installers and CI run it where a systemd or container credential is not yet present. One that becomes unreadable later is a failed connect attempt (counted as `auth`, logged, retried after the long auth back-off), never a crash. |
| `downlink.gate` | Optional timings for the enrolment gate (below). There is no switch to turn downlink on: it opens only for an enrolled device. |

## The enrolment gate

The firmware treats a USB cable caller as local, and a device with no Deployment record accepts unsigned requests from it, including first provisioning and resets. Anything the Connector wrote from the broker would arrive as that caller. So broker messages reach the device **only while the device itself says it is enrolled**; an unenrolled device gets uplink only. The state is never taken from configuration.

- **How it asks.** The Connector sends the device `{"v":1,"id":"cg-<n>","op":"deployment.get"}`, an unsigned read, in the active framing (`0x7F` frames in `companion` mode, one `mecon> ` line in `console` mode). Downlink opens only when the answer is `status` `ok` with `result.state` `"provisioned"`. `none`, `corrupt`, a `refused`, an answer that does not parse, no answer within 8 s, or anything else means closed.
- **When.** When the serial port opens, when a broker session is (re)established, on a new `epoch` (a reboot), every 10 minutes while open, and every 30 s while closed. The two intervals and the timeout are `downlink.gate` settings with bounds.
- **Close at once.** While a record exists, every interface event and result carries `usig`. The first uplink interface message without it closes downlink immediately (that is what follows a `deployment.reset`), the message is still forwarded unchanged, and downlink reopens only after a fresh `deployment.get` says `provisioned`.
- **What it reads.** Only its own reply (matched by the reserved id prefix `cg-`), whether a top-level `usig` member is present, and an epoch (`epoch`, `result.epoch` or `usig_boot`). Uplink is never altered and always forwarded, except the device's answer to the Connector's own request, which is the Connector's traffic: neither the request nor its answer is published upstream.
- **While closed,** broker messages are dropped and counted (`downlink_closed_total`), never held and never replayed after the gate reopens.
- **When open,** the Connector is a plain bridge: it does not check signatures or operations on relayed content. For an enrolled device the firmware requires a member's signature for everything but reads, and unsigned reads are relayed by decision. Restrict who may publish to `down` with the broker ACL anyway.
- **One request at a time.** The firmware handles one interface message at a time, so the Connector's request can interleave with a Backend request in flight; the Backend re-sends with the same id on a `busy` answer.
- **Native Companion frames** are not interface messages: they stay dropped and counted, uplink and downlink.

## What it does

Serial to broker:

- `companion` mode reads the `>` wrapper (marker, 16-bit length, at most 176 bytes), resynchronises on garbage, refuses an oversize length at once, and reassembles `0x7F` interface frames (up to 25 frames, 4096 bytes) into one message. Native Companion frames are counted and not forwarded.
- `console` mode reads `mecon> {` lines (at most 1600 bytes with the prefix, CR or LF terminated) and skips echo and log lines without buffering them.
- Each complete message becomes one MQTT publish of exactly those bytes, QoS 1, not retained.

Broker to serial (only while the gate is open): each message on the down topic is wrapped (`0x7F` frames in `<` wrappers, or one `mecon> ` line) and written once. Retained messages are refused. An empty, oversize or (console) line-breaking message is dropped and counted, never rewritten.

On shutdown the Connector releases the device explicitly: it publishes the status `offline` and closes the broker session before it exits.

The Connector also publishes a retained status message `{"v":1,"connector":"online|offline","serial":"up|down|unknown"}` with a last will. It is the Connector's own state, never the device's presence.

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
- The mutation script breaks 27 rules (payload altered, in-doubt publish re-queued, a command written again after a reconnect, unbounded buffering, a duplicate publish on a repeated frame, silent drops and others) and requires a test failure for each.

## What is not verified

- Nothing has run with a real USB radio. Not verified: that a Companion's USB accepts `0x7F` frames on every build and before the app handshake, that boot text never precedes frames, that opening the port does not reset the board (an ESP32-S3 may reset on open, an nRF52 bridge may need DTR), and that 115200 baud is right for every board.
- Nothing has run against the Backend or its broker policy. Topic names are provisional until the Backend confirms the mapping at stage C3. The enrolment gate has run only against a fake device that models `deployment.get`, `epoch` and `usig` from the firmware docs; the real answers, the exact place of `epoch` in them, and whether an enrolled device accepts any unsigned read that returns data the Backend alone should see are unverified. Q4 and Q6 in the contract are open.
- No Pi measurements: resident memory, CPU at sustained traffic, reconnect time, and behaviour under UART byte loss are unknown on a Pi. CI measures a runner (labelled as such); the Pi run is the pooled owner step under "Measurements".
- The systemd unit has run on a CI VM (Ubuntu, systemd 255) and, by hand, on Debian 12 (systemd 252) in a container; not on a Pi, and not with a real serial device, so `DeviceAllow` for `ttyACM` and `ttyUSB` and the `dialout` group on a real radio are untested. `LoadCredential=` did not populate in a nested-container test environment (a container limitation, not seen on a VM); the CI VM run is the evidence.
- The TLS check was exercised against a synthetic CA and mosquitto 2.0.x only. Failure classification between a certificate failure and a plain network failure depends on paho's log text and is best effort; both fail closed.
- Hot-unplug on Linux is covered by a fake device. The real error codes from a vanished USB serial port were not observed.
- The multi-arch image builds for arm64 under emulation in CI only; it has not been run on arm hardware.
