# BLE probe: real-hardware evidence on iPhone and iPad (Bluefy)

The Reader ships a read-only Bluetooth probe at `/probe/ble`. It collects
evidence of what a real browser and a real MeshCore Companion do over Web
Bluetooth. It is reachable without signing in and is linked only from
Settings, under "Bluetooth diagnostics".

**Nothing is transmitted over radio.** The probe connects, sends read-only
requests that ask the Companion who it is, reads the answers and disconnects.
It sends them in this order: the MECON device interface `hello` carried as a
`0x7F` frame (`CMD_MECON`), the Companion device query (`22`), and the Companion
app start (`1`). It sends no message, channel text or advert, and it changes no
setting. This is enforced in code: every write passes the shared read-only frame
guard (`classifyProbeFrame` in `reader/src/device/guard.ts`), the per-driver
allowlist:

- Companion native: app start `1` and device query `22`
  (`ALLOWED_CMD_CODES` in `reader/src/ble/probe/probeCore.ts`).
- Device interface: one `0x7F` frame carrying a request of the read operations
  `hello`, `status.get` or `clock.get`, with no arguments and no authority
  (`MECON_READ_OPS`). The detection sends only `hello`.

Anything else is refused before it reaches Bluetooth, and unit and browser tests
fail if the probe can emit another operation. There is no battery step: the supported
protocol subset has no battery command, so it is reported as "unsupported" and
nothing is sent for it. The probe stores nothing.

## Steps for a tester

You need an iPhone or iPad, a MeshCore Companion that is powered on, and the
Bluefy browser (Safari has no Web Bluetooth).

1. Install **Bluefy** from the App Store.
2. In Bluefy open the `/probe/ble` page of the restricted Reader (the testers are given its address).
3. Tap **Connect and run probe**.
4. In the chooser pick your Companion. If the chooser is empty see below.
5. Enter the Companion's PIN if the phone asks for it.
6. Wait until every step shows a result and the button says **Run again**.
7. Tap **Copy report**. If copying is blocked, select the text in the report
   box and copy it by hand.
8. Send the report to the maintainers (for example as a comment on the Bluefy
   hardware-evidence thread in this repository's issue tracker), with the
   phone model, iOS version, Bluefy version and the Companion's firmware
   version.

## If the chooser is empty

- Power the Companion on and turn Bluetooth on in the phone.
- Disconnect any other app or client from the Companion (it accepts one
  connection at a time) and make sure the phone is not already paired to it
  in system Bluetooth settings.
- Move close to the Companion and tap **Run again**.
- Use Bluefy, not Safari or an in-app browser.

## What each step means

| Step | Pass means | Fail, unsupported or unknown means |
|---|---|---|
| Browser support | `navigator.bluetooth` exists (and `availability()` is not false) | Unsupported: the browser has no Web Bluetooth. Fail: Bluetooth reports itself unavailable |
| Device chooser | You picked a device from the chooser | Fail: the chooser was closed, empty, or permission was denied (the error name says which) |
| Connect | The GATT connection was made | Fail: the Companion was out of range, busy, or refused the connection |
| Service discovery | The Companion's BLE service and its two characteristics were found | Fail: the device is not a Companion, or exposes a different service |
| Start notifications | Notifications on the reply characteristic started | Fail: the browser or device refused them (a PIN prompt that was not completed shows up here) |
| Hello: interface hello (0x7F) and device query | The shared detection ran (see "What the probe identifies"), and the Companion answered the device query; firmware version and capability fields are in the report | Fail: no or wrong answer within 8 s (the note still carries what was identified) |
| Self-info response | The Companion answered the app start with its self info | Fail: no or wrong answer within 8 s |
| Battery | Always "unsupported": no battery command in the supported subset | n/a |
| Disconnect | The link closed and the browser reported it | Unknown: the call returned but no disconnect event was seen |

"Unknown" never means failed: it means the probe could not observe the result,
or did not run the step because an earlier one failed. "Service discovery" and
"Start notifications" are timed separately by the Web Bluetooth transport; with
any other transport they show "unknown" because they are covered by "Connect".

## What the probe identifies

After the link is up, the probe runs the same detection as the USB probe, minus
the console-line step, because BLE carries no console (only Companions have
BLE; Repeaters and Room servers have none). Per the public firmware's owner, the
interface rides in Companion frames as `0x7F` over BLE as on USB. The detection
sends the interface `hello` first, then the Companion device query, and reports
one of:

- `MECON firmware vX, role R, interface 1.0, capabilities ...`: `hello` answered.
  Role, firmware and capabilities come from the answer only.
- `Not MECON firmware or older ...`: no interface answer (a stock Companion
  answers `0x7F` with a Companion error frame), but the Companion device query
  was answered, so the binary messaging driver works.
- `MECON device interface refused hello (link not trusted) ...`: the interface
  answered `refused`. The device is not identified from that.
- `Unknown device ...`: nothing answered.

It is never inferred from the device or board name, which the detection does not
read.

**Link trust is `unknown`.** The firmware trusts a BLE link paired with a PIN other
than `0` or `123456` like the cable, and gives a default-PIN link messaging and
reads but never secrets or management. Per the firmware's authority contract, a
caller on a default PIN is among those refused `hello`. A web page cannot read
which PIN a bond used, so the Reader records `linkTrust: "unknown"` and asks only for
operations of class `read` on such a link (`reader/src/device/trust.ts`). A
device on a default PIN may therefore answer `refused` even to the probe's
`hello`; that is reported, not worked around.

## The report

A JSON document: probe version and bundle commit, timestamp, user agent,
whether `navigator.bluetooth` exists, `availability()`, each step's status,
timing in milliseconds and error name, code and message, the command codes that
were written, and the firmware version and protocol capability fields from the
device query. It is sanitized: it never contains public keys, device names,
node names, coordinates, Bluetooth device ids or PINs. The `detected` block
(version 2 of the report) adds the identified firmware, role, interface version,
capabilities, carriage, `linkTrust`, the labels of every request written
(`commandsSent`, for example `frame-iface:hello`) and the detection evidence,
sanitized as the rest. Keys and ids appear only as presence flags or lengths (for example `publicKeyPresent`, `nodeNameLength`,
`locationPresent`). Error text is scrubbed for names, ids, long hex strings,
MAC-like strings and six-digit numbers. Read the report before you post it.

## Evidence

Results are recorded as hardware evidence for Bluefy on iPhone and iPad (see the [acceptance matrix](MVP1_ACCEPTANCE.md)). A
run on real hardware is evidence for that browser, device and firmware only.
Runs against the simulated Companion in the test suite are labelled SIMULATED
and are not hardware evidence. Nothing in this repository claims that the
detection, the probe or the device session has been verified on real hardware.

## Design notes

- The probe is its own lazy chunk (`React.lazy` plus a dynamic import), so the
  main bundle contains no BLE UUID and no `requestDevice`. `e2e/ble-prod.spec.ts`
  checks that the entry chunk is clean and that exactly one chunk, the probe,
  holds BLE code.
- The route is registered before the sign-in gate and uses no Backend call.
- The interface hello and the device query run before the app start. UNVERIFIED
  on hardware: whether a Companion needs the opposite order, and whether a
  Companion answers a `0x7F` frame before `app start` (the same open question as
  on USB); the report shows which step failed.
- UNVERIFIED: that every released MECON Companion build answers the interface over
  BLE with the same `0x7F` framing as over USB (stated by the firmware's owner on
  the tracking Issue, and in `DEVICE_INTERFACE.md` "USB and BLE (Companion
  builds)"; not observed here).
- The e2e tests inject a fake `navigator.bluetooth` with `addInitScript`
  against the production preview build; the app has no test-only code path.

The USB counterpart for laptops (any device role, over Web Serial) is [USB_PROBE.md](USB_PROBE.md).
