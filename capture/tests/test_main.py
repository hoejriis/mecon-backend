import os
import pathlib
import signal
import subprocess
import sys
import time

from mecon_capture.__main__ import main

ROOT = pathlib.Path(__file__).resolve().parents[1]


def write_cfg(tmp_path, extra=""):
    p = tmp_path / "c.toml"
    p.write_text(f"""
[archive]
path = "{tmp_path}/a.sqlite3"
[ingester]
instance_tag = "m1"
[health]
enabled = false
[[profile]]
name = "src-one"
host = "127.0.0.1"
port = 1
transport = "tcp"
topics = ["a/#"]
adapter = "raw_hex"
tls = {{ enabled = false, verify = true }}
{extra}
""")
    return str(p)


def test_check_config_and_version(tmp_path, capsys):
    assert main(["--check-config", "--config", write_cfg(tmp_path)]) == 0
    assert main(["--version"]) == 0
    bad = tmp_path / "bad.toml"
    bad.write_text("[archive]\n")
    assert main(["--config", str(bad)]) == 2
    assert "config error" in capsys.readouterr().err


def test_missing_credential_variable_stops_startup(tmp_path, capsys, monkeypatch):
    monkeypatch.delenv("SYN_USER_VAR", raising=False)
    cfg = write_cfg(tmp_path, 'credential = { username_ref = "SYN_USER_VAR" }')
    assert main(["--config", cfg]) == 2
    err = capsys.readouterr().err
    assert "SYN_USER_VAR" in err


def test_sigterm_stops_cleanly(tmp_path):
    cfg = write_cfg(tmp_path)
    env = dict(os.environ, PYTHONPATH=str(ROOT / "src"), PYTHONDONTWRITEBYTECODE="1")
    p = subprocess.Popen([sys.executable, "-m", "mecon_capture", "--config", cfg], env=env,
                         stderr=subprocess.PIPE, text=True)
    time.sleep(1.0)
    p.send_signal(signal.SIGTERM)
    out = p.communicate(timeout=20)[1]
    assert p.returncode == 0 and '"event":"stopped"' in out
