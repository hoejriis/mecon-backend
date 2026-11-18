# BLE probe: real-hardware evidence on iPhone and iPad (Bluefy)

The Reader ships a read-only Bluetooth probe at `/probe/ble`. It collects
evidence of what a real browser and a real MeshCore Companion do over Web
Bluetooth. It is reachable without signing in and is linked only from
Settings, under "Bluetooth diagnostics".

**Nothing is transmitted over radio.** The probe connects, sends two read-only
commands (device query and app start, which ask the Companion who it is),
reads the answers and disconnects. It sends no message, channel text or
advert, and it changes no setting. This is enforced in code: every write passes
an allowlist of command codes (`ALLOWED_CMD_CODES` in
`reader/src/ble/probe/probeCore.ts`: app start `1` and device query `22`);
anything else is refused before it reaches Bluetooth, and a unit test fails if
the probe can emit another code. There is no battery step: the supported
protocol subset has no battery command, so it is reported as "unsupported" and
nothing is sent for it. The probe stores nothing.

## Steps for a tester

You need an iPhone or iPad, a MeshCore Companion that is powered on, and the
Bluefy browser (Safari has no Web Bluetooth).

1. Install **Bluefy** from the App Store.
2. In Bluefy open `https://reader.mecon.cloud/probe/ble`.
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
| Hello: device query response | The Companion answered the device query; firmware version and capability fields are in the report | Fail: no or wrong answer within 8 s |
| Self-info response | The Companion answered the app start with its self info | Fail: no or wrong answer within 8 s |
| Battery | Always "unsupported": no battery command in the supported subset | n/a |
| Disconnect | The link closed and the browser reported it | Unknown: the call returned but no disconnect event was seen |

"Unknown" never means failed: it means the probe could not observe the result,
or did not run the step because an earlier one failed. "Service discovery" and
"Start notifications" are timed separately by the Web Bluetooth transport; with
any other transport they show "unknown" because they are covered by "Connect".

## The report

A JSON document: probe version and bundle commit, timestamp, user agent,
whether `navigator.bluetooth` exists, `availability()`, each step's status,
timing in milliseconds and error name, code and message, the command codes that
were written, and the firmware version and protocol capability fields from the
device query. It is sanitized: it never contains public keys, device names,
node names, coordinates, Bluetooth device ids or PINs. Those appear only as
presence flags or lengths (for example `publicKeyPresent`, `nodeNameLength`,
`locationPresent`). Error text is scrubbed for names, ids, long hex strings,
MAC-like strings and six-digit numbers. Read the report before you post it.

## Evidence

Results are recorded as hardware evidence for Bluefy on iPhone and iPad (see the [acceptance matrix](MVP1_ACCEPTANCE.md)). A
run on real hardware is evidence for that browser, device and firmware only.
Runs against the simulated Companion in the test suite are labelled SIMULATED
and are not hardware evidence.

## Design notes

- The probe is its own lazy chunk (`React.lazy` plus a dynamic import), so the
  main bundle contains no BLE UUID and no `requestDevice`. `e2e/ble-prod.spec.ts`
  checks that the entry chunk is clean and that exactly one chunk, the probe,
  holds BLE code.
- The route is registered before the sign-in gate and uses no Backend call.
- The device query runs before the app start. UNVERIFIED on hardware: whether
  a Companion needs the opposite order; the report shows which step failed.
- The e2e tests inject a fake `navigator.bluetooth` with `addInitScript`
  against the production preview build; the app has no test-only code path.
