"""Serial discovery, selection by stable id, and the pyserial link."""

from __future__ import annotations

import fnmatch
import os
import stat
from dataclasses import dataclass, field

from .config import Selector
from .transport import SerialAmbiguous, SerialGone, SerialLink, SerialUnavailable

BY_ID_DIR = "/dev/serial/by-id"


@dataclass(frozen=True)
class PortInfo:
    device: str  # the kernel node, e.g. /dev/ttyACM0; never used as an identity
    vid: int | None = None
    pid: int | None = None
    usb_serial: str | None = None
    by_id_names: tuple[str, ...] = field(default_factory=tuple)


def list_ports(by_id_dir: str = BY_ID_DIR) -> list[PortInfo]:
    from serial.tools import list_ports as lp

    links: dict[str, list[str]] = {}
    try:
        for name in sorted(os.listdir(by_id_dir)):
            links.setdefault(os.path.realpath(os.path.join(by_id_dir, name)), []).append(name)
    except OSError:
        pass
    return [
        PortInfo(p.device, p.vid, p.pid, p.serial_number, tuple(links.get(os.path.realpath(p.device), ())))
        for p in lp.comports()
    ]


def open_path(sel: Selector) -> str:
    """The explicit path of a path selector, if it names a character device now.

    No enumeration: the operator named the port (normally a udev symlink such as /dev/bench/<name>), so
    nothing else is ever a candidate. An absent path is "not plugged in yet" and is polled, like a stable id.
    """
    assert sel.path is not None
    try:
        mode = os.stat(sel.path).st_mode  # follows the symlink
    except OSError:
        raise SerialUnavailable("the selected port path does not exist") from None
    if not stat.S_ISCHR(mode):
        raise SerialUnavailable("the selected port path is not a character device")
    return sel.path


class SelectorOverlap(SerialUnavailable):
    """The port found also matches a selector it must not (the device's and the bootloader's port are one)."""


def _real(path: str) -> str:
    try:
        return os.path.realpath(path)
    except (OSError, ValueError):
        return path


def matches(port: PortInfo, sel: Selector) -> bool:
    """Whether `port` is one `sel` selects. The one predicate for selection and for the overlap guard."""
    if sel.path is not None:
        return port.device == sel.path or _real(port.device) == _real(sel.path)
    if sel.by_id is not None:
        return any(fnmatch.fnmatchcase(n, sel.by_id) for n in port.by_id_names)
    if port.vid != sel.vid or port.pid != sel.pid:
        return False
    return sel.usb_serial is None or port.usb_serial == sel.usb_serial


def select_port(ports: list[PortInfo], sel: Selector) -> PortInfo:
    found = [p for p in ports if matches(p, sel)]
    if not found:
        raise SerialUnavailable("no port matches the selector")
    if len({p.device for p in found}) > 1:
        raise SerialAmbiguous(f"{len(found)} ports match the selector")
    return found[0]


class PySerialLink:
    """A real port, opened exclusively. read() polls with a short timeout."""

    def __init__(self, device: str, baud: int, poll_s: float = 0.05) -> None:
        import serial

        self._serial_mod = serial
        try:
            self._ser = serial.Serial(device, baud, timeout=poll_s, write_timeout=2.0, exclusive=True)
        except (serial.SerialException, OSError) as e:
            raise SerialGone(type(e).__name__) from e

    def read(self, max_bytes: int) -> bytes:
        try:
            n = self._ser.in_waiting
            return self._ser.read(min(max(n, 1), max_bytes))
        except (self._serial_mod.SerialException, OSError, TypeError) as e:
            raise SerialGone(type(e).__name__) from e

    def write(self, data: bytes) -> None:
        try:
            self._ser.write(data)
            self._ser.flush()
        except (self._serial_mod.SerialException, OSError) as e:
            raise SerialGone(type(e).__name__) from e

    def close(self) -> None:
        try:
            self._ser.close()
        except Exception:  # noqa: BLE001 - closing a dead port must not raise
            pass


def resolve_port(sel: Selector, lister=list_ports) -> PortInfo:  # type: ignore[no-untyped-def]
    """The one port `sel` names now, with what is known about it (for a path, found among the listed ports by
    its real node, so another selector can be checked against it)."""
    if sel.path is not None:
        path = open_path(sel)
        real = _real(path)
        for p in lister():
            if _real(p.device) == real:
                return PortInfo(path, p.vid, p.pid, p.usb_serial, p.by_id_names)
        return PortInfo(path)
    return select_port(lister(), sel)


class PortOpener:
    """Opens the port a selector names. `avoid`, when set, is a selector the port must not also match: such a
    port is refused with SelectorOverlap before it is opened, so nothing is ever written to it."""

    def __init__(self, sel: Selector, baud: int, lister=list_ports, link_factory=None) -> None:  # type: ignore[no-untyped-def]
        self.sel = sel
        self.baud = baud
        self.lister = lister
        self.link_factory = link_factory or PySerialLink
        self.avoid: Selector | None = None

    def __call__(self) -> SerialLink:
        port = resolve_port(self.sel, self.lister)
        if self.avoid is not None and matches(port, self.avoid):
            raise SelectorOverlap("the port also matches the other selector")
        return self.link_factory(port.device, self.baud)


    def present(self) -> bool:
        """Whether a port the selector names exists now. Nothing is opened or written. A port that also matches
        `avoid` is not counted (it is not told apart from the other device)."""
        try:
            found = [p for p in self.lister() if matches(p, self.sel)]
        except OSError:
            return False
        if self.avoid is not None:
            found = [p for p in found if not matches(p, self.avoid)]
        return len({p.device for p in found}) == 1


def make_opener(sel: Selector, baud: int) -> PortOpener:
    return PortOpener(sel, baud)
