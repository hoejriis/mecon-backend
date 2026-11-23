import json

import pytest
from helpers import b64, envelope, packet

from mecon_processing.adapters import extract, number, observer_key, trusted_device_time

HEX = packet(payload=b"abc").hex()
AT = "2026-01-01T00:00:00.000Z"
RECV_S = 1767225600  # 2026-01-01T00:00:00Z
TOPIC = "meshcore/AB12/obs-1/packets"


def env(topic=TOPIC, at=AT, **kw):
    kw.setdefault("data", HEX)
    return extract("observer_envelope", topic, json.dumps(kw).encode(), at)


def test_observer_keys():
    assert observer_key("observer_envelope", "a/b/obs/packets") == "obs"
    assert observer_key("observer_envelope", "a/obs/packets") is None  # fewer than 4 segments
    assert observer_key("observer_envelope", "a/b//packets") is None  # empty segment
    assert observer_key("raw_hex", "packets/obs-9") == "obs-9"
    assert observer_key("raw_hex", "obs") is None
    assert observer_key("raw_hex", "packets/") is None
    with pytest.raises(ValueError):
        observer_key("nonsense", "a/b")


def test_only_packet_topics_are_packets():
    assert env(topic="meshcore/AB12/obs-1/status").skip == "not_a_packet"
    assert env(topic="meshcore/AB12/obs-1/raw").skip is None
    assert env(topic="meshcore/AB12/obs-1/packets/x").skip == "not_a_packet"
    assert env(topic="meshcore/AB12/obs-1/xpackets").skip == "not_a_packet"


def test_envelope_must_be_a_json_object():
    for body in (b"not json", b"[1]", b"1", b'"x"', b"null", b"", b'{"data": NaN, "x": 1}', b"\xef\xbb\xbf{}"):
        assert extract("observer_envelope", TOPIC, body, AT).skip == "malformed", body
    assert extract("observer_envelope", TOPIC, b"\xff\xfe", AT).skip == "malformed"


def test_own_transmissions_are_not_packets():
    assert env(direction="tx").skip == "not_a_packet"
    assert env(direction="rx").skip is None
    assert env(direction="TX").skip is None


def test_packet_bytes_first_present_field_must_be_usable():
    assert env(data=HEX, raw_data="zz").data == bytes.fromhex(HEX)
    assert env(data="zz", raw_data=HEX).skip == "malformed"  # a present, unusable field is not passed over
    assert extract("observer_envelope", TOPIC, envelope(raw_data=HEX), AT).data == bytes.fromhex(HEX)
    assert extract("observer_envelope", TOPIC, envelope(raw=HEX), AT).data == bytes.fromhex(HEX)
    assert extract("observer_envelope", TOPIC, envelope(raw_data="q", raw=HEX), AT).skip == "malformed"
    assert extract("observer_envelope", TOPIC, envelope(other=HEX), AT).skip == "malformed"
    for bad in ("1", "abc", "0x15", "15 00", " 1500", "15\n", 5, None, ["15"], True):
        assert env(data=bad).skip == "malformed", bad
    assert env(data="").skip is None and env(data="").data == b""  # a well-formed envelope with zero bytes
    assert env(data="AbCd").data == b"\xab\xcd"


def test_origin_check_ignores_case_and_needs_a_named_observer():
    assert env(origin_id="OBS-1").skip is None
    assert env(origin_id="Obs-1").skip is None
    assert env(origin_id="obs-7").skip == "origin_mismatch"
    assert env(origin_id="").skip is None
    assert env(origin_id=5).skip is None
    assert env(origin_id="obs-7", topic="a/obs/packets").skip is None  # topic names no observer: nothing to check against
    assert env(topic="meshcore/AB12/OBS-1/packets", origin_id="obs-1").skip is None


@pytest.mark.parametrize("v,want", [
    (5, 5), (-90, -90), (7.5, 7.5), ("-101", -101.0), (" 3.25 ", 3.25), ("+4", 4.0), (".5", 0.5), ("5.", 5.0),
    ("1e2", 100.0), ("-2.5E-1", -0.25), ("\t7\n", 7.0),
    ("", None), ("  ", None), ("abc", None), ("0x10", None), ("1_000", None), ("1,5", None), ("inf", None),
    ("-Infinity", None), ("nan", None), ("1e999", None), ("--1", None), ("1 2", None), ("١٢", None),
    (True, None), (False, None), (None, None), ([1], None), ({}, None), (float("inf"), None), (float("nan"), None),
])
def test_number_grammar(v, want):
    assert number(v) == want
    assert (number(v) is None) == (want is None)


def test_rssi_and_snr_keys_and_the_zero_rule():
    assert env(RSSI=-90, rssi=-50).rssi == -90  # upper case first
    assert env(rssi=-50).rssi == -50
    assert env(SNR=3, snr=9).snr == 3
    assert env(snr="2.5").snr == 2.5
    assert env(RSSI="junk", rssi=-50).rssi is None  # the upper-case field is present, so it is the one read
    assert env(RSSI=0).rssi is None and env(RSSI="0").rssi is None and env(RSSI=-0.0).rssi is None and env(RSSI="0.0").rssi is None
    assert env(RSSI=0.5).rssi == 0.5
    assert env(SNR=0).snr == 0 and env(SNR=0).snr is not None  # SNR 0 is a reading
    assert env().rssi is None and env().snr is None


def test_device_time_window():
    assert trusted_device_time(1735689600, AT) == 1735689600  # the floor itself
    assert trusted_device_time(1735689599, AT) is None
    assert trusted_device_time(RECV_S + 60, AT) == RECV_S + 60  # received_at plus 60 s
    assert trusted_device_time(RECV_S + 61, AT) is None
    assert trusted_device_time(RECV_S + 60, "2026-01-01T00:00:00.999Z") == RECV_S + 60
    assert trusted_device_time(RECV_S + 61, "2026-01-01T00:00:00.999Z") is None
    assert trusted_device_time(RECV_S + 61, "2026-01-01T00:00:01.000Z") == RECV_S + 61
    assert trusted_device_time(RECV_S + 60.9, AT) == RECV_S + 60  # truncated to whole seconds
    assert trusted_device_time(f"{RECV_S - 5}.9", AT) == RECV_S - 5
    assert trusted_device_time(str(RECV_S), AT) == RECV_S
    assert trusted_device_time(True, AT) is None and trusted_device_time(False, AT) is None
    assert trusted_device_time(None, AT) is None and trusted_device_time("x", AT) is None
    assert trusted_device_time(0, AT) is None and trusted_device_time(-5, AT) is None
    assert env(ts=RECV_S - 1).device_observed_at == RECV_S - 1
    assert env(ts=True).device_observed_at is None


def test_the_device_time_window_follows_received_at():
    assert trusted_device_time(RECV_S + 3600, "2026-01-01T01:00:00.000Z") == RECV_S + 3600
    assert trusted_device_time(RECV_S + 3600, AT) is None


def test_raw_hex_format():
    f = lambda b: extract("raw_hex", "packets/obs-9", b, AT)  # noqa: E731
    assert f(HEX.encode()).data == bytes.fromhex(HEX)
    assert f(b"  " + HEX.encode() + b"\n").data == bytes.fromhex(HEX)
    assert (f(b"15").rssi, f(b"15").snr, f(b"15").device_observed_at) == (None, None, None)
    for bad in (b"", b"   ", b"zz", b"1", b"15 00", b"\xff\xff", "abé".encode(), b"\x00"):
        assert f(bad).skip == "malformed", bad


def test_unknown_adapter_is_refused_not_defaulted():
    with pytest.raises(ValueError):
        extract("made_up", TOPIC, b"{}", AT)


def test_origin_id_ignores_surrounding_whitespace_and_a_blank_one_claims_nothing():
    import json

    from mecon_processing.adapters import extract

    topic = "meshcore/AB12/obs-1/packets"
    def outcome(origin):
        x = extract("observer_envelope", topic, json.dumps({"data": "1500a1b2c3d4e5f60718", "origin_id": origin}).encode(), "2026-01-01T00:00:00.000Z")
        return x.skip
    assert outcome(" OBS-1 ") is None  # the same observer, with whitespace and another case
    assert outcome("   ") is None  # blank: no claim, so no mismatch
    assert outcome("obs-7") == "origin_mismatch"
