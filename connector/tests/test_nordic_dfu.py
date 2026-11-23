"""The legacy Nordic serial DFU codec, package reader, package check, fetch and transfer driver
(mecon_connector.nordic_dfu), against hand-computed vectors and an independently written fake bootloader."""

import hashlib
import io
import json
import random
import zipfile

import pytest

from conftest import Clock
from fakes.fake_bootloader import FakeBootloader, crc_ccitt
from fakes.fake_hold_server import TOKEN, FakeHoldServer
from hold_rig import hold_cfg
from mecon_connector import nordic_dfu as nd


def make_zip(image=b"", init=b"\x12\x34", manifest=None, extra=None):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(
            manifest if manifest is not None else {"manifest": {"application": {"bin_file": "app.bin", "dat_file": "app.dat"}}}))
        z.writestr("app.bin", image)
        z.writestr("app.dat", init)
        for k, v in (extra or {}).items():
            z.writestr(k, v)
    return buf.getvalue()


IMAGE = bytes(range(256)) * 21 + b"\xc0\xdb\xc0"  # 5379 bytes: 11 data packets, with both SLIP specials
INIT = b"\xc0init\xdbpacket"


class FakeTime:
    def __init__(self):
        self.clock = Clock()
        self.slept = []

    def sleep(self, s):
        self.slept.append(s)
        self.clock.advance(s)


# ---- codec vectors ---------------------------------------------------------------------------------


def test_crc16_is_ccitt_false_check_value_and_matches_an_independent_implementation():
    assert nd.crc16(b"123456789") == 0x29B1  # the catalogued check value of CRC-16/CCITT-FALSE
    rnd = random.Random(7)
    for n in (0, 1, 5, 64, 517):
        data = bytes(rnd.randrange(256) for _ in range(n))
        assert nd.crc16(data) == crc_ccitt(data)


def test_header_of_the_stop_packet_with_seq_1_by_hand():
    # b0 = seq 1 | ack 2 << 3 | integrity 1 << 6 | reliable 1 << 7 = 0xD1; b1 = type 14 | (len 4 & 0xF) << 4 = 0x4E;
    # b2 = (4 & 0xFF0) >> 4 = 0; b3 = two's complement of the sum: -(0xD1 + 0x4E) & 0xFF = 0xE1.
    assert nd.hci_header(1, 4) == bytes.fromhex("d14e00e1")
    body = bytes.fromhex("d14e00e1") + bytes.fromhex("05000000")
    c = crc_ccitt(body)
    assert nd.encode_packet(1, nd.stop_payload()) == b"\xc0" + body + bytes((c & 0xFF, c >> 8)) + b"\xc0"


def test_header_length_bits_and_checksum_for_every_seq_and_a_data_packet_length():
    for seq in range(8):
        for length in (0, 1, 15, 16, 516, 4095):
            h = nd.hci_header(seq, length)
            assert sum(h) & 0xFF == 0
            assert h[0] & 7 == seq and (h[0] >> 3) & 7 == (seq + 1) % 8 and h[0] >> 6 == 3
            assert h[1] & 0xF == 14 and (h[1] >> 4) | (h[2] << 4) == length
    with pytest.raises(ValueError):
        nd.hci_header(1, 4096)


def test_slip_escaping_round_trip_and_no_c0_inside_a_frame():
    data = bytes([0xC0, 0x01, 0xDB, 0xDC, 0xDD, 0xC0])
    esc = nd.slip_escape(data)
    assert esc == bytes([0xDB, 0xDC, 0x01, 0xDB, 0xDD, 0xDC, 0xDD, 0xDB, 0xDC])
    assert nd.slip_unescape(esc) == data
    assert nd.slip_unescape(b"\xdb\x01") is None and nd.slip_unescape(b"\xdb") is None
    pkt = nd.encode_packet(3, nd.u32(4) + IMAGE[:512])
    assert pkt[0] == 0xC0 and pkt[-1] == 0xC0 and 0xC0 not in pkt[1:-1]
    inner = nd.slip_unescape(pkt[1:-1])
    assert crc_ccitt(inner[:-2]) == inner[-2] | (inner[-1] << 8)


def test_slip_reader_skips_noise_splits_and_drops_overlong_frames():
    r = nd.SlipReader(max_frame=8)
    ack = b"\xc0" + bytes([2 << 3, 0, 0, (256 - (2 << 3)) % 256]) + b"\xc0"
    out = []
    for b in b"noise" + ack[:3]:
        out += r.feed(bytes([b]))
    out += r.feed(ack[3:] + b"\xc0" + b"\x01" * 20 + b"\xc0")
    assert out == [ack[1:-1]]
    assert r.discarded >= 5 + 20
    assert nd.ack_number(out[0]) == 2
    assert nd.ack_number(bytes([2 << 3, 0, 0, 1])) is None  # bad header checksum


def test_payloads_start_init_data_stop():
    assert nd.start_payload(5379) == bytes.fromhex("03000000" "04000000" "00000000" "00000000") + (5379).to_bytes(4, "little")
    assert nd.init_payload(b"\xaa") == bytes.fromhex("01000000aa0000")
    chunks = nd.data_payloads(IMAGE)
    assert [len(c) - 4 for c in chunks] == [512] * 10 + [5379 - 5120]
    assert all(c[:4] == b"\x04\x00\x00\x00" for c in chunks)
    assert nd.stop_payload() == b"\x05\x00\x00\x00"
    assert nd.erase_wait_s(100) == 0.5
    assert nd.erase_wait_s(409600) == pytest.approx(101 * 0.0897)


# ---- the package -----------------------------------------------------------------------------------


def test_read_package_takes_the_application_image_and_init_packet():
    pkg = nd.read_package(make_zip(IMAGE, INIT))
    assert pkg.image == IMAGE and pkg.init == INIT


@pytest.mark.parametrize("manifest,why", [
    ({"manifest": {}}, "no-application"),
    ({"manifest": {"softdevice": {"bin_file": "app.bin", "dat_file": "app.dat"}}}, "not-application-only"),
    ({"manifest": {"application": {"bin_file": "app.bin", "dat_file": "app.dat"},
                   "bootloader": {"bin_file": "app.bin", "dat_file": "app.dat"}}}, "not-application-only"),
    ({"manifest": {"application": {"bin_file": "missing.bin", "dat_file": "app.dat"}}}, "bad-package"),
    ({"other": 1}, "no-manifest"),
])
def test_read_package_refuses_what_is_not_an_application_package(manifest, why):
    with pytest.raises(nd.PackageError) as e:
        nd.read_package(make_zip(IMAGE, INIT, manifest=manifest))
    assert (e.value.stage, e.value.error) == ("verify", why)


def test_read_package_refuses_garbage_and_an_empty_image():
    for data in (b"PK\x03\x04 not a zip", b"", make_zip(b"", INIT)):
        with pytest.raises(nd.PackageError) as e:
            nd.read_package(data)
        assert e.value.stage == "verify"


def test_verify_package_checks_size_then_sha256():
    data = make_zip(IMAGE, INIT)
    good = hashlib.sha256(data).hexdigest()
    nd.verify_package(data, len(data), good)
    with pytest.raises(nd.PackageError) as e:
        nd.verify_package(data, len(data) + 1, good)
    assert e.value.error == "size-mismatch"
    with pytest.raises(nd.PackageError) as e:
        nd.verify_package(data, len(data), "0" * 64)
    assert e.value.error == "sha256-mismatch"


# ---- the fetch -------------------------------------------------------------------------------------


@pytest.fixture
def server():
    s = FakeHoldServer()
    yield s
    s.shutdown()


def _hc(server, tmp_path, token=TOKEN):
    tf = tmp_path / "t"
    tf.write_text(token + "\n")
    tf.chmod(0o600)
    return hold_cfg(server.url, tf).hold


def test_fetch_uses_the_hold_token_as_bearer_on_the_package_route(server, tmp_path):
    data = make_zip(IMAGE, INIT)
    server.packages["job-1"] = data
    got = nd.make_fetcher(_hc(server, tmp_path), 1 << 20)("job-1")
    assert got == data
    path, headers = server.package_requests[-1]
    assert path == "/gateway/dfu-package/job-1"
    assert headers["authorization"] == f"Bearer {TOKEN}"


def test_fetch_refusals_are_codes_and_never_carry_the_token(server, tmp_path):
    hc = _hc(server, tmp_path)
    f = nd.make_fetcher(hc, 1 << 20)
    with pytest.raises(nd.PackageError) as e:
        f("no-such-job")
    assert (e.value.stage, e.value.error) == ("fetch", "http-404")
    assert TOKEN not in repr(e.value) and e.value.__cause__ is None
    server.package_status = 302
    with pytest.raises(nd.PackageError) as e:
        f("job-1")
    assert e.value.error == "http-302"  # a redirect is not followed
    server.package_status = None
    server.packages["big"] = b"x" * 70000
    with pytest.raises(nd.PackageError) as e:
        nd.make_fetcher(hc, 65536)("big")
    assert (e.value.stage, e.value.error) == ("verify", "too-large")


def test_fetch_with_the_wrong_token_is_a_404_like_any_other_refusal(server, tmp_path):
    server.packages["job-1"] = b"x"
    with pytest.raises(nd.PackageError) as e:
        nd.make_fetcher(_hc(server, tmp_path, token="another-token-0000"), 1 << 20)("job-1")
    assert e.value.error == "http-404"


def test_package_url_for_ws_and_prefix_bases(tmp_path, server):
    hc = _hc(server, tmp_path)
    assert nd.package_url(hc, "a:b.c") == f"{server.url}/gateway/dfu-package/a%3Ab.c"


# ---- the transfer ----------------------------------------------------------------------------------


def run(boot, image=IMAGE, init=INIT, t=None):
    t = t or FakeTime()
    tr = nd.Transfer(boot, t.clock, t.sleep)
    tr.run(nd.Package(init, image))
    return tr, t


def test_transfer_sends_start_init_data_stop_and_the_exact_image():
    t = FakeTime()
    boot = FakeBootloader(clock=t.clock)
    tr, _ = run(boot, t=t)
    assert boot.complete, boot.errors
    assert boot.order == ["start", "init"] + ["data"] * 11 + ["stop"]
    assert boot.start == (4, 0, 0, len(IMAGE))
    assert boot.init == INIT and bytes(boot.image) == IMAGE
    assert boot.data_sizes == [512] * 10 + [len(IMAGE) - 5120]
    assert tr.resends == 0 and boot.duplicates == 0
    # the erase wait after start, the init wait, a page write wait after data packets 0 and 8, and the last page
    assert boot.times[1] - boot.times[0] >= nd.erase_wait_s(len(IMAGE))
    assert boot.times[2] - boot.times[1] >= nd.INIT_PACKET_WAIT_S
    assert t.slept.count(nd.FLASH_PAGE_WRITE_S) == 3


def test_transfer_sequence_numbers_start_at_1_and_wrap():
    boot = FakeBootloader()
    run(boot, image=b"\x01" * (512 * 9))  # 12 packets: seq 1..7, 0, 1..4
    assert boot.complete and boot.last_seq == 12 % 8


def test_a_lost_ack_is_resent_after_the_timeout_and_the_bootloader_takes_it_once():
    t = FakeTime()
    boot = FakeBootloader(drop_acks={0, 3, 13})
    tr, t = run(boot, t=t)
    assert boot.complete, boot.errors
    assert tr.resends == 3 and boot.duplicates == 3
    assert bytes(boot.image) == IMAGE


def test_a_stale_ack_is_not_taken_for_the_packet_it_does_not_answer():
    # The bootloader loses data packet 5 and repeats the previous packet's ack. A driver that took any ack as
    # success would send packet 6 next and the bootloader would see a gap.
    boot = FakeBootloader(stale_instead={5})
    tr, _ = run(boot)
    assert boot.complete, boot.errors
    assert tr.stale_acks == 1 and tr.resends == 1
    assert bytes(boot.image) == IMAGE


def test_noise_around_acks_is_ignored():
    boot = FakeBootloader(noise=True)
    run(boot)
    assert boot.complete, boot.errors


def test_a_bootloader_that_never_answers_fails_after_four_writes_of_the_first_packet():
    boot = FakeBootloader(dead=True)
    t = FakeTime()
    with pytest.raises(nd.TransferError) as e:
        run(boot, t=t)
    assert str(e.value) == "no-ack"
    assert boot.frames == nd.SEND_ATTEMPTS
    assert t.clock() - 1000.0 >= nd.SEND_ATTEMPTS * nd.ACK_TIMEOUT_S


def test_a_port_that_disappears_mid_transfer_is_link_lost():
    boot = FakeBootloader(gone_after=4)
    with pytest.raises(nd.TransferError) as e:
        run(boot)
    assert str(e.value) == "link-lost"
