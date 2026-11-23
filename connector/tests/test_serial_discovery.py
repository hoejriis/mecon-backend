import pytest

from mecon_connector.config import Selector
from mecon_connector.serial_link import PortInfo, matches, select_port
from mecon_connector.transport import SerialAmbiguous, SerialUnavailable

A = PortInfo("/dev/ttyACM0", 0x303A, 0x1001, "SYN0001", ("usb-TEST_synthetic-if00",))
B = PortInfo("/dev/ttyACM1", 0x303A, 0x1001, "SYN0002", ("usb-TEST_synthetic2-if00",))
C = PortInfo("/dev/ttyUSB0", 0x10C4, 0xEA60, None, ())


def test_by_id_glob_picks_one():
    assert select_port([A, B, C], Selector(by_id="usb-TEST_synthetic2-*")) is B


def test_kernel_node_name_is_not_an_identity():
    # the same device re-enumerated under another node is still found by its stable id
    moved = PortInfo("/dev/ttyACM7", A.vid, A.pid, A.usb_serial, A.by_id_names)
    assert select_port([moved, C], Selector(by_id="usb-TEST_synthetic-*")).device == "/dev/ttyACM7"


def test_vid_pid_serial():
    assert select_port([A, B], Selector(vid=0x303A, pid=0x1001, usb_serial="SYN0002")) is B


def test_ambiguous_is_refused_not_guessed():
    with pytest.raises(SerialAmbiguous):
        select_port([A, B], Selector(vid=0x303A, pid=0x1001))
    with pytest.raises(SerialAmbiguous):
        select_port([A, B], Selector(by_id="usb-TEST_*"))


def test_nothing_matches():
    with pytest.raises(SerialUnavailable):
        select_port([C], Selector(by_id="usb-TEST_*"))
    assert not matches(C, Selector(vid=1, pid=2))


def test_port_opener_refuses_a_port_that_also_matches_the_avoided_selector_before_opening_it():
    from mecon_connector.serial_link import PortOpener, SelectorOverlap

    opened = []
    o = PortOpener(Selector(by_id="usb-TEST_*"), 115200, lister=lambda: [A], link_factory=lambda d, b: opened.append(d) or d)
    assert o() == "/dev/ttyACM0"
    o.avoid = Selector(vid=0x303A, pid=0x1001)
    with pytest.raises(SelectorOverlap):
        o()
    assert opened == ["/dev/ttyACM0"]  # the refused port was never opened
    o.avoid = Selector(vid=0x303A, pid=0x9999)
    assert o() == "/dev/ttyACM0"


def test_a_path_selector_is_matched_by_its_real_node(tmp_path):
    from mecon_connector.serial_link import matches

    node = tmp_path / "ttyACM5"
    node.write_text("")
    link = tmp_path / "bench-radio"
    link.symlink_to(node)
    p = PortInfo(str(node), 1, 2, None, ())
    assert matches(p, Selector(path=str(link))) and not matches(p, Selector(path=str(tmp_path / "other")))
