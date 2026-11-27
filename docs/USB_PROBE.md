# USB probe: real-hardware evidence from a laptop browser (Web Serial)

The Reader ships a read-only USB diagnostics page at `/probe/usb`. It collects
evidence of what a real desktop Chromium browser and a real MeshCore device do
over Web Serial. It works for any device role: a Companion, a Repeater, a Room
server, or a device that is none of these (it is reported "unknown"). It is
reachable without signing in and is linked only from Settings, under "USB
diagnostics". **Every result from the automated suite is SIMULATED, not
hardware verified; no hardware compatibility is claimed until this step has
been run.**

**Nothing is transmitted over radio.** The probe opens the port you choose,
sends only read requests, reads the answers and closes the port. It sends no
message, advert or setting and stores nothing. This is enforced in code: every
write passes `classifyProbeWrite` in `reader/src/device/guard.ts`, which allows
exactly these units and refuses everything else before it reaches the port:

| Unit | Allowed | Source |
|---|---|---|
| Device interface line `mecon> {"v":1,"id":..,"op":..}` | `op` is `hello`, `status.get` or `clock.get`, with no `args` and no `auth` | mecon-firmware `docs/contract/DEVICE_INTERFACE.md` section 7, `OPERATIONS.md` (class `read`) |
| Device interface in one `0x7F` frame inside the serial wrapper | the same three operations | same |
| Stock console line | exactly `ver`, `board`, `get role`, `get mecon.version`, one CR, nothing attached (the firmware matches by prefix) | mecon-firmware `docs/CLI.md`, `docs/CLI_REFERENCE.md`; MeshCore `src/helpers/CommonCLI.cpp` |
| Companion binary frame | app start (1) and device query (22) only | MeshCore `examples/companion_radio/MyMesh.cpp` |

Identification order (each step read-only, 2 s wait, stops at the first that
answers): the interface `hello` as a console line (Repeater, Room server); if
only a stock console answers, `ver`, `get role`, `board`; if nothing answers,
the interface `hello` in `0x7F` frames (Companion), then the Companion device
query. The role comes only from what the device answers (hello's `role`, or
`get role`, or answering Companion frames), never from a board name, USB id or
version string. If nothing answers the result is "unknown".

## The pooled UAT step (one run, owner)

You need a laptop with desktop **Chrome** (or Edge or Opera), and a MeshCore
device running the public MECON firmware: a Companion, or a Repeater or Room
server. Run it once per device you have.

1. Plug the device into the laptop with a **data** cable (some cables only
   charge). Close any serial monitor, flasher or other Reader tab that might
   hold the port.
2. In Chrome open the `/probe/usb` page of the restricted Reader (the testers are given its address).
3. Click **Connect and run probe**.
4. In Chrome's port chooser pick the device's port (it is named like `USB
   Serial`, `usbmodem...` or `ttyACM...`) and click **Connect**. If the list is
   empty see below.
5. Wait until every step shows a result and the button says **Run again**
   (up to about 45 s: boards often restart when the port opens and answer 13 to 26 s later).
6. Click **Copy report**. If copying is blocked, select the text in the report
   box and copy it by hand.
7. Post the report on the laptop USB Companion tracking Issue in this repository's
   issue tracker with the
   laptop OS and version, the Chrome version, the board model and the firmware
   version.

## If the chooser is empty or the port will not open

- Use a data cable and wait a few seconds after plugging in.
- Close other tabs and programs that use the serial port: it can be open in
  one place only ("busy").
- Use desktop Chrome, Edge or Opera. Safari and Firefox have no Web Serial.
- If the port opens but nothing answers, let the device finish starting and
  run again.

## What each step means

| Step | Pass means | Fail, unsupported or unknown means |
|---|---|---|
| Browser support | `navigator.serial` exists in a secure context | Unsupported: no Web Serial |
| Port chooser | You picked a port | Fail: the chooser was closed, empty, or permission was denied |
| Open the port | The port opened at 115200 baud | Fail: busy (open elsewhere) or the OS refused |
| Identify the device | The device answered a read request; the report says which firmware, role, interface version and capabilities | Unknown: nothing answered; Fail: the link was lost |
| Close the port | The port closed and the browser reported it | Unknown: close returned without a report |

"Unknown" never means failed: it means the probe could not observe the result.

## The report

A JSON document: probe version and bundle commit, timestamp, user agent,
whether `navigator.serial` exists, each step's status, timing and error, the
labels of every unit written (for example `iface:hello`), the USB vendor and
product id as the browser reports them (model level), and what was detected:
firmware (MECON or unknown), role and where it came from, interface version,
which carriage answered, the capabilities, the operations hello listed, and
presence flags for the device id and node key. It never contains the device id,
node key, node name, coordinates or passwords. Text is scrubbed for long hex
strings, MAC-like strings and six-digit numbers. Read it before you post it.

## Design notes

- The probe is its own lazy chunk (`/probe/usb`), so the main bundle holds no
  `navigator.serial` and no `requestPort`. `e2e/ble-prod.spec.ts` checks the
  entry chunk and that index.html does not load or preload the probe chunks.
- Web Serial opens at 115200 baud (the rate the firmware source opens); a
  native USB port ignores it. DTR and RTS are left as the browser sets them.
  UNVERIFIED on hardware: whether any board resets when the port opens, which
  would make the first request go unanswered (run again).
- No USB vendor filter is applied to the chooser: the list of bridges used by
  supported boards is unverified.
- The e2e tests inject a fake `navigator.serial` with `addInitScript` against
  the production preview build; the app has no test-only code path.
