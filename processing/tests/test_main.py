import json
import os
import pathlib
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

import pytest
from test_archive_e2e import make_archive

from mecon_processing.__main__ import main
from mecon_processing.health import make_server, serve_in_thread
from mecon_processing.store import Store

SRC = pathlib.Path(__file__).resolve().parents[1] / "src"


def write_config(tmp_path, port=0, health=True, sources='[sources.own-broker]\nadapter = "observer_envelope"\n'
                 '[sources.open-feed]\nadapter = "raw_hex"\n'):
    p = tmp_path / "config.toml"
    p.write_text(f'[archive]\npath = "{tmp_path / "archive.sqlite3"}"\n[store]\npath = "{tmp_path / "out.sqlite3"}"\n'
                 f'[processor]\ninterval_s = 0.05\n[health]\nenabled = {str(health).lower()}\nport = {port}\n' + sources)
    return str(p)


def test_check_config_and_bad_config(tmp_path, capsys):
    assert main(["--config", write_config(tmp_path), "--check-config"]) == 0
    assert main(["--config", write_config(tmp_path, sources='[sources.x]\nadapter = "nope"\n')]) == 2
    assert "adapter" in capsys.readouterr().err
    assert main(["--config", str(tmp_path / "missing.toml")]) == 2
    assert main(["--version"]) == 0


def test_a_missing_archive_is_refused_not_created(tmp_path):
    assert main(["--config", write_config(tmp_path), "--once"]) == 2
    assert not (tmp_path / "archive.sqlite3").exists()


def test_once_processes_what_is_pending_and_exits(tmp_path):
    make_archive(tmp_path / "archive.sqlite3")
    cfg = write_config(tmp_path)
    assert main(["--config", cfg, "--once"]) == 0
    assert main(["--config", cfg, "--once"]) == 0  # again: nothing new, nothing doubled
    s = Store(str(tmp_path / "out.sqlite3"))
    assert len(s.outcomes()) == 5 and len(s.receptions()) == 2 and s.progress() == 5


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def get(port, path="/healthz"):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=2) as r:
        return json.loads(r.read())


def test_the_loop_serves_health_picks_up_new_captures_and_stops_gracefully(tmp_path, schemas):
    make_archive(tmp_path / "archive.sqlite3")
    port = free_port()
    cfg = write_config(tmp_path, port=port)
    env = dict(os.environ, PYTHONPATH=str(SRC), PYTHONDONTWRITEBYTECODE="1")
    proc = subprocess.Popen([sys.executable, "-m", "mecon_processing", "--config", cfg], env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        doc = None
        deadline = time.time() + 15
        while time.time() < deadline:
            try:
                doc = get(port)
                if doc["counters"]["processed"] == 5:
                    break
            except (urllib.error.URLError, ConnectionError):
                pass
            time.sleep(0.1)
        assert doc is not None and doc["counters"]["processed"] == 5 and doc["progress"] == 5
        assert schemas["counters"].is_valid(doc["counters"])
        assert doc["counters"]["pending"] == 0 and doc["counters"]["oldest_pending_ms"] is None
        # a capture committed later is processed without a restart
        from test_archive_e2e import Archive, HEX, doc as mkdoc
        if Archive is not None:
            a = Archive(str(tmp_path / "archive.sqlite3"), max_payload_bytes=64)
            a.append("b2", [mkdoc("packets/obs-2", HEX.encode(), "2026-01-01T00:00:09.000Z", source="open-feed")])
            a.close()
            deadline = time.time() + 15
            while time.time() < deadline and get(port)["counters"]["processed"] < 6:
                time.sleep(0.1)
            assert get(port)["counters"]["processed"] == 6
        with pytest.raises(urllib.error.HTTPError) as e:
            get(port, "/other")
        assert e.value.code == 404
        proc.send_signal(signal.SIGTERM)
        assert proc.wait(timeout=10) == 0
        err = proc.stderr.read().decode()
        assert '"event":"started"' in err and '"event":"stopped"' in err
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.stdout.close()
        proc.stderr.close()


def test_health_server_binds_loopback_by_default_and_reports_a_snapshot():
    server = make_server("127.0.0.1", 0, lambda: {"counters": {"processed": 0}})
    serve_in_thread(server)
    try:
        assert server.server_address[0] == "127.0.0.1"
        assert get(server.server_address[1]) == {"counters": {"processed": 0}}
    finally:
        server.shutdown()
        server.server_close()
