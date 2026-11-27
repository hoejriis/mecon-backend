"""Legacy Nordic serial DFU, as adafruit-nrfutil's serial transport sends it, for the hold's bootloader DFU.

A device that answers a bootloader-dfu offer resets into its bootloader, which takes the release's DFU package
over USB serial: HCI packets in SLIP frames at 115200 baud, in the order start, init (the package's `.dat`),
data (the `.bin` in 512-byte packets) and stop. Each packet waits for its acknowledgement. The bootloader
checks the image; the Connector never signs or alters a byte of it.

What is here, all without I/O of its own: the SLIP and HCI codec, the package reader (stdlib zipfile, in
memory), the package check against the Backend's dfu_job (size and SHA-256), and the transfer driver over an
abstract byte link (read/write, as transport.SerialLink) with an injected clock and sleep, so tests run it
against a fake bootloader in fake time. The HTTPS fetch of the package is `make_fetcher`.
"""

from __future__ import annotations

import hashlib
import io
import json
import ssl
import struct
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from dataclasses import dataclass
from typing import Any, Callable

from .config import ConfigError, HoldConfig, read_token
from .transport import SerialGone, SerialLink

BAUD = 115200

# HCI packet (adafruit-nrfutil dfu_transport_serial.py and util.py)
DFU_INIT_PACKET = 1
DFU_START_PACKET = 3
DFU_DATA_PACKET = 4
DFU_STOP_DATA_PACKET = 5
MODE_APPLICATION = 4
HCI_PACKET_TYPE = 14
DATA_INTEGRITY_CHECK_PRESENT = 1
RELIABLE_PACKET = 1
DATA_PACKET_MAX = 512

# timing (adafruit-nrfutil): the bootloader's CPU is blocked while it erases or writes flash
FLASH_PAGE_SIZE = 4096
FLASH_PAGE_ERASE_S = 0.0897
FLASH_PAGE_WRITE_S = (FLASH_PAGE_SIZE / 4) * 0.000100  # 0.1024 s
INIT_PACKET_WAIT_S = 1.0
ACK_TIMEOUT_S = 1.0
SEND_ATTEMPTS = 4  # one write and up to three resends of the same packet
IDLE_SLEEP_S = 0.002  # between empty reads while waiting for an ack (a real port read already waits)

SLIP_END = 0xC0
SLIP_ESC = 0xDB
SLIP_ESC_END = 0xDC
SLIP_ESC_ESC = 0xDD
MAX_ACK_FRAME = 64  # an acknowledgement is a 4-byte header; anything longer while waiting is noise

MAX_MANIFEST_BYTES = 64 * 1024
MAX_INIT_BYTES = 4000  # the init packet travels in one HCI packet (12-bit length) with its opcode and padding
MAX_IMAGE_BYTES = 4 * 1024 * 1024


# ---- codec ---------------------------------------------------------------------------------


def crc16(data: bytes, crc: int = 0xFFFF) -> int:
    """CRC-16/CCITT (polynomial 0x1021), initial 0xFFFF, as nrfutil's crc16.calc_crc16."""
    for b in data:
        crc = ((crc >> 8) & 0x00FF) | ((crc << 8) & 0xFF00)
        crc ^= b
        crc ^= (crc & 0x00FF) >> 4
        crc ^= (crc << 8) << 4
        crc ^= ((crc & 0x00FF) << 4) << 1
        crc &= 0xFFFF
    return crc


def slip_escape(data: bytes) -> bytes:
    out = bytearray()
    for b in data:
        if b == SLIP_END:
            out += bytes((SLIP_ESC, SLIP_ESC_END))
        elif b == SLIP_ESC:
            out += bytes((SLIP_ESC, SLIP_ESC_ESC))
        else:
            out.append(b)
    return bytes(out)


def slip_unescape(data: bytes) -> bytes | None:
    """The bytes inside one frame; None for an escape that is not one of the two defined ones."""
    out = bytearray()
    esc = False
    for b in data:
        if esc:
            if b == SLIP_ESC_END:
                out.append(SLIP_END)
            elif b == SLIP_ESC_ESC:
                out.append(SLIP_ESC)
            else:
                return None
            esc = False
        elif b == SLIP_ESC:
            esc = True
        else:
            out.append(b)
    return None if esc else bytes(out)


def hci_header(seq: int, length: int, dip: int = DATA_INTEGRITY_CHECK_PRESENT, rp: int = RELIABLE_PACKET,
               pkt_type: int = HCI_PACKET_TYPE) -> bytes:
    """nrfutil's slip_parts_to_four_bytes: seq and ack = seq+1 (3 bits each), the integrity and reliable flags,
    the packet type (4 bits), the payload length (12 bits) and a checksum byte that makes the four sum to 0."""
    if not 0 <= seq <= 7 or not 0 <= length <= 0xFFF:
        raise ValueError("seq or length out of range")
    b0 = seq | (((seq + 1) % 8) << 3) | (dip << 6) | (rp << 7)
    b1 = pkt_type | ((length & 0x000F) << 4)
    b2 = (length & 0x0FF0) >> 4
    b3 = (~(b0 + b1 + b2) + 1) & 0xFF
    return bytes((b0, b1, b2, b3))


def encode_packet(seq: int, payload: bytes) -> bytes:
    """One HCI packet on the wire: C0, SLIP-escaped(header, payload, CRC16 little-endian), C0."""
    body = hci_header(seq, len(payload)) + payload
    c = crc16(body)
    return bytes((SLIP_END,)) + slip_escape(body + bytes((c & 0xFF, c >> 8))) + bytes((SLIP_END,))


def ack_number(frame: bytes) -> int | None:
    """The ack field of a frame from the bootloader (unescaped, without the C0s); None if it is too short.

    The header checksum is not required: the browser Reader's port of the same transfer, proven on hardware,
    reads only the ack field, and a frame with a wrong ack number is resent anyway."""
    if len(frame) < 4:
        return None
    return (frame[0] >> 3) & 0x07


class SlipReader:
    """Cuts a byte stream into SLIP frames (unescaped). Bytes before the first C0 and over-long frames are dropped."""

    def __init__(self, max_frame: int = MAX_ACK_FRAME) -> None:
        self._buf = bytearray()
        self._in_frame = False
        self._overflow = False
        self.max_frame = max_frame
        self.discarded = 0

    def feed(self, data: bytes) -> list[bytes]:
        out: list[bytes] = []
        for b in data:
            if b == SLIP_END:
                if self._in_frame and self._buf and not self._overflow:
                    frame = slip_unescape(bytes(self._buf))
                    if frame is None:
                        self.discarded += len(self._buf)
                    else:
                        out.append(frame)
                elif self._overflow:
                    self.discarded += len(self._buf)
                self._buf.clear()
                self._overflow = False
                self._in_frame = True  # a C0 both ends one frame and may start the next
            elif not self._in_frame:
                self.discarded += 1
            elif len(self._buf) >= self.max_frame:
                self._overflow = True
                self.discarded += 1
            else:
                self._buf.append(b)
        return out


def u32(v: int) -> bytes:
    return struct.pack("<I", v)


def start_payload(app_size: int) -> bytes:
    return u32(DFU_START_PACKET) + u32(MODE_APPLICATION) + u32(0) + u32(0) + u32(app_size)


def init_payload(init: bytes) -> bytes:
    return u32(DFU_INIT_PACKET) + init + struct.pack("<H", 0)


def data_payloads(image: bytes) -> list[bytes]:
    return [u32(DFU_DATA_PACKET) + image[i : i + DATA_PACKET_MAX] for i in range(0, len(image), DATA_PACKET_MAX)]


def stop_payload() -> bytes:
    return u32(DFU_STOP_DATA_PACKET)


def erase_wait_s(app_size: int) -> float:
    """nrfutil's get_erase_wait_time: at least 0.5 s, else one page erase time per page plus one."""
    return max(0.5, ((app_size / FLASH_PAGE_SIZE) + 1) * FLASH_PAGE_ERASE_S)


# ---- the package ---------------------------------------------------------------------------


class PackageError(Exception):
    """A package that cannot be used. stage is fetch or verify; error is a short code, never secret."""

    def __init__(self, stage: str, error: str) -> None:
        super().__init__(f"{stage}: {error}")
        self.stage = stage
        self.error = error


@dataclass(frozen=True)
class Package:
    init: bytes  # the .dat init packet
    image: bytes  # the application .bin


def verify_package(data: bytes, size: int, sha256: str) -> None:
    """The package bytes are exactly the ones the Backend named in dfu_job: size first, then SHA-256."""
    if len(data) != size:
        raise PackageError("verify", "size-mismatch")
    if hashlib.sha256(data).hexdigest() != sha256:
        raise PackageError("verify", "sha256-mismatch")


def read_package(data: bytes) -> Package:
    """The application image and init packet of a DFU zip, from its manifest.json. In memory only.

    Only an application package is taken (start mode 4); a package that also carries a SoftDevice or a
    bootloader is refused, because this transfer would not write them."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
        man = _member(zf, "manifest.json", MAX_MANIFEST_BYTES)
        manifest = json.loads(man.decode("utf-8")).get("manifest")
        if not isinstance(manifest, dict):
            raise PackageError("verify", "no-manifest")
        if set(manifest) - {"application", "dfu_version"}:
            raise PackageError("verify", "not-application-only")
        app = manifest.get("application")
        if not isinstance(app, dict):
            raise PackageError("verify", "no-application")
        bin_name, dat_name = app.get("bin_file"), app.get("dat_file")
        if not isinstance(bin_name, str) or not isinstance(dat_name, str):
            raise PackageError("verify", "no-application")
        image = _member(zf, bin_name, MAX_IMAGE_BYTES)
        init = _member(zf, dat_name, MAX_INIT_BYTES)
    except PackageError:
        raise
    except Exception:  # noqa: BLE001  any malformed zip, member or manifest is one refusal
        raise PackageError("verify", "bad-package") from None
    if not image or not init:
        raise PackageError("verify", "empty-image")
    return Package(init, image)


def _member(zf: zipfile.ZipFile, name: str, limit: int) -> bytes:
    info = zf.getinfo(name)
    if info.file_size > limit:
        raise PackageError("verify", "member-too-large")
    with zf.open(info) as f:
        out = f.read(limit + 1)
    if len(out) > limit:
        raise PackageError("verify", "member-too-large")
    return out


# ---- the fetch -----------------------------------------------------------------------------


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect is refused: the token goes to the configured Backend and nowhere else."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


def http_base(hc: HoldConfig) -> str:
    """{base} with an http(s) scheme: the hold's base URL as configured, without a trailing slash."""
    base = hc.base_url.rstrip("/")
    if base.startswith("wss://"):
        return "https://" + base[6:]
    if base.startswith("ws://"):
        return "http://" + base[5:]
    return base


def package_url(hc: HoldConfig, job: str) -> str:
    return f"{http_base(hc)}/gateway/dfu-package/{urllib.parse.quote(job, safe='')}"


def make_fetcher(hc: HoldConfig, max_bytes: int, timeout_s: float = 30.0) -> Callable[[str], bytes]:
    """GET {base}/gateway/dfu-package/{job} with the hold's own token as Authorization: Bearer. The token is
    read from its file for this request only and never logged; TLS uses the hold's ca_file; no proxy and no
    redirect. Raises PackageError("fetch", <code>)."""

    def fetch(job: str) -> bytes:
        url = package_url(hc, job)
        try:
            token = read_token(hc.token_file, "header")
        except ConfigError:
            raise PackageError("fetch", "credential") from None
        handlers: list = [urllib.request.ProxyHandler({}), _NoRedirect()]
        if url.startswith("https://"):
            handlers.append(urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=hc.ca_file)))
        opener = urllib.request.build_opener(*handlers)
        req = urllib.request.Request(url, headers={
            "Authorization": f"Bearer {token}", "Accept": "application/zip", "User-Agent": "mecon-connector"})
        del token
        try:
            with opener.open(req, timeout=timeout_s) as resp:
                if resp.status != 200:
                    raise PackageError("fetch", f"http-{resp.status}")
                length = resp.headers.get("Content-Length")
                if length is not None and length.isdigit() and int(length) > max_bytes:
                    raise PackageError("verify", "too-large")
                data = resp.read(max_bytes + 1)
        except PackageError:
            raise
        except urllib.error.HTTPError as e:
            code = e.code
            e.close()  # the error carries the open response; release the connection
            raise PackageError("fetch", f"http-{code}") from None
        except ssl.SSLError:
            raise PackageError("fetch", "tls") from None
        except Exception:  # noqa: BLE001  counted by class, never by message (it could name the URL)
            raise PackageError("fetch", "network") from None
        finally:
            req.headers.clear()
        if len(data) > max_bytes:
            raise PackageError("verify", "too-large")
        return data

    return fetch


# ---- the transfer --------------------------------------------------------------------------


class TransferError(Exception):
    """A transfer attempt that did not complete. The bootloader takes a fresh start at any time."""


class TransferInterrupted(Exception):
    """The transfer was told to stop (the Connector is shutting down) and ended between two frames. It is not a
    failure of the bootloader and never a success: no stop packet was sent. `sent` data packets were acknowledged
    of `total`."""

    def __init__(self, sent: int, total: int) -> None:
        super().__init__("interrupted")
        self.sent = sent
        self.total = total


class Transfer:
    """Sends one package to a bootloader over `link`. One instance per attempt: the sequence numbers start
    again at 1 (nrfutil numbers its first packet 1).

    `stop` (anything with is_set(), such as threading.Event) is looked at before every frame is written, never
    inside one: once it is set the frame in flight is finished and acknowledged, no further frame is written,
    and run() raises TransferInterrupted. The caller closes the port."""

    def __init__(self, link: SerialLink, clock: Callable[[], float], sleep: Callable[[float], None],
                 stop: Any = None) -> None:
        self.link = link
        self.clock = clock
        self.sleep = sleep
        self.stop = stop
        self.sent = 0  # data packets acknowledged
        self.total = 0  # data packets in the package
        self.seq = 0
        self.reader = SlipReader()
        self.resends = 0
        self.stale_acks = 0

    def send(self, payload: bytes) -> None:
        self.seq = (self.seq + 1) % 8
        frame = encode_packet(self.seq, payload)
        want = (self.seq + 1) % 8
        for attempt in range(SEND_ATTEMPTS):
            self._check_stop()
            if attempt:
                self.resends += 1
            try:
                self.link.write(frame)
            except SerialGone:
                raise TransferError("link-lost") from None
            if self._wait_ack(want):
                return
        raise TransferError("no-ack")

    def _check_stop(self) -> None:
        if self.stop is not None and self.stop.is_set():
            raise TransferInterrupted(self.sent, self.total)

    def _wait_ack(self, want: int) -> bool:
        deadline = self.clock() + ACK_TIMEOUT_S
        while True:
            try:
                data = self.link.read(MAX_ACK_FRAME)
            except SerialGone:
                raise TransferError("link-lost") from None
            for frame in self.reader.feed(data):
                ack = ack_number(frame)
                if ack == want:
                    return True
                if ack is not None:
                    self.stale_acks += 1  # an earlier packet's ack, repeated: keep waiting for ours
            if self.clock() >= deadline:
                return False
            if not data:
                self.sleep(IDLE_SLEEP_S)

    def run(self, pkg: Package, progress: Callable[[int, int], None] | None = None) -> None:
        size = len(pkg.image)
        chunks = data_payloads(pkg.image)
        self.total = len(chunks)
        self.send(start_payload(size))
        self.sleep(erase_wait_s(size))
        self.send(init_payload(pkg.init))
        self.sleep(INIT_PACKET_WAIT_S)
        for count, payload in enumerate(chunks):
            self.send(payload)
            self.sent = count + 1
            if progress is not None:
                progress(self.sent, self.total)
            # nrfutil: the bootloader erases and writes a flash page per 8 packets (4096 bytes) with its CPU
            # blocked; it waits after packets 0, 8, 16 ...
            if count % 8 == 0:
                self.sleep(FLASH_PAGE_WRITE_S)
        self.sleep(FLASH_PAGE_WRITE_S)  # the last page
        self.send(stop_payload())


def run_transfer(link: SerialLink, pkg: Package, clock: Callable[[], float], sleep: Callable[[float], None],
                 stop: Any = None, progress: Callable[[int, int], None] | None = None) -> None:
    Transfer(link, clock, sleep, stop).run(pkg, progress)
