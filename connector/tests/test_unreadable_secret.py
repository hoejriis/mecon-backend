"""Issue #76: an unreadable password_file is a config error at startup and a counted connect failure later.

Directory and absent-file cases also run as root (the CI test container); mode 000 is skipped for root,
which can read it, and the skip is reported by `pytest -ra`.
"""

import os

import pytest

import mecon_connector.paho_transport as pt
from conftest import Rig
from mecon_connector.__main__ import main
from mecon_connector.config import ConfigError, read_secret
from mecon_connector.paho_transport import PahoTransport
from mecon_connector.transport import TransportError, Will

SECRET = "synthetic-test-password"


def write_config(tmp_path, pw_path):
    cfg = tmp_path / "config.toml"
    cfg.write_text(
        '[device]\nmode = "companion"\n[device.select]\nby_id = "usb-X-*"\n'
        '[mqtt]\nclient_id = "c1"\ntopic_root = "a/b"\n'
        f'[[mqtt.brokers]]\nname = "p"\nhost = "h.invalid"\nusername = "u"\npassword_file = "{pw_path}"\n'
    )
    return cfg


def unreadable(tmp_path, kind):
    if kind == "directory":
        p = tmp_path / "pw"
        p.mkdir()
    elif kind == "absent":
        p = tmp_path / "pw-missing"
    else:
        if os.geteuid() == 0:
            pytest.skip("root can read a mode 000 file")
        p = tmp_path / "pw"
        p.write_text(SECRET)
        p.chmod(0)
    return p


KINDS = ["directory", "absent", "mode000"]


@pytest.mark.parametrize("kind,flags", [(k, f) for k in KINDS for f in (["--check-config"], [])
                                         if not (k == "absent" and f)])
def test_startup_and_check_config_exit_2_with_one_line_naming_the_path(tmp_path, capsys, kind, flags):
    p = unreadable(tmp_path, kind)
    rc = main(["--config", str(write_config(tmp_path, p))] + flags)
    err = capsys.readouterr().err.strip().splitlines()
    assert rc == 2
    assert len(err) == 1 and str(p) in err[0] and err[0].startswith("config error:")
    assert "Traceback" not in err[0] and SECRET not in err[0]


def test_check_config_tolerates_a_credential_that_only_exists_at_run_time(tmp_path, capsys):
    """Installers and CI run --check-config where a systemd or container credential is not present."""
    p = tmp_path / "later-credential"
    assert main(["--config", str(write_config(tmp_path, p)), "--check-config"]) == 0
    cap = capsys.readouterr()
    assert cap.out.strip() == "config ok" and str(p) in cap.err and "note:" in cap.err


def test_readable_password_file_still_passes_check_config(tmp_path, capsys):
    p = tmp_path / "pw"
    p.write_text(SECRET + "\n")
    assert main(["--config", str(write_config(tmp_path, p)), "--check-config"]) == 0
    assert capsys.readouterr().out.strip() == "config ok"


def test_read_secret_error_names_path_and_class_only(tmp_path):
    p = tmp_path / "pw"
    p.write_bytes(b"\xff\xfe" + SECRET.encode())  # not UTF-8
    with pytest.raises(ConfigError) as e:
        read_secret(str(p))
    assert str(p) in e.value.problems[0] and SECRET not in str(e.value) and "UnicodeDecodeError" in e.value.problems[0]


@pytest.mark.parametrize("kind", KINDS)
def test_credential_unreadable_at_reconnect_is_a_counted_failed_attempt_not_a_crash(tmp_path, monkeypatch, kind):
    p = unreadable(tmp_path, kind)

    class Stub:
        def __init__(self, *a, **k):
            raise AssertionError("no client may be created when the credential cannot be read")

    monkeypatch.setattr(pt.mqtt, "Client", Stub)
    rig = Rig(mqtt={"brokers": [{"name": "primary", "host": "p.invalid", "tls": False, "insecure_allow_plain": True,
                                  "username": "u", "password_file": str(p)}]})
    rig.bridge.transport = real = PahoTransport("cid", 30)
    real.callbacks = rig.bridge
    rig.step(5)  # would raise out of step() before the fix
    assert rig.metrics.get("broker_connect_attempts_total", "auth") == 1
    assert rig.metrics.get("broker_connected") == 0
    rig.step(20, dt=1.0)  # within the 60 s auth back-off: no tight retry loop
    assert rig.metrics.get("broker_connect_attempts_total", "auth") == 1


def test_transport_connect_raises_transport_error_for_unreadable_secret(tmp_path):
    from conftest import make_cfg
    b = make_cfg().mqtt.brokers[0]
    b = type(b)(**{**b.__dict__, "username": "u", "password_file": str(tmp_path / "missing")})
    with pytest.raises(TransportError):
        PahoTransport("cid", 30).connect(b, Will("t/s", b"x", 1, True), [])
