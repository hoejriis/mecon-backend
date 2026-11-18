"""Serial discovery, selection by stable id, and the pyserial link."""

from __future__ import annotations

import fnmatch
import os
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


def matches(port: PortInfo, sel: Selector) -> bool:
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


def make_opener(sel: Selector, baud: int):  # type: ignore[no-untyped-def]
    def opener() -> SerialLink:
        port = select_port(list_ports(), sel)
        return PySerialLink(port.device, baud)

    return opener
