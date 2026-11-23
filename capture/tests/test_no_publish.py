"""The ingester has no publish path: not in the transport seam, not in any module, not anywhere in the source."""

import ast
import pathlib

from mecon_capture.ingester import Ingester
from mecon_capture.transport import Transport

SRC = pathlib.Path(__file__).resolve().parents[1] / "src" / "mecon_capture"


def test_source_has_no_publish_anywhere():
    hits = []
    for f in sorted(SRC.glob("*.py")):
        for node in ast.walk(ast.parse(f.read_text())):
            names = []
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                names.append(node.name)
            elif isinstance(node, ast.Attribute):
                names.append(node.attr)
            elif isinstance(node, ast.Name):
                names.append(node.id)
            elif isinstance(node, ast.arg):
                names.append(node.arg)
            elif isinstance(node, ast.Constant) and isinstance(node.value, str) and len(node.value) < 40:
                names.append(node.value)
            for n in names:
                if "publish" in n.lower():
                    hits.append(f"{f.name}:{node.lineno}: {n}")
    assert hits == []


def test_transport_seam_declares_exactly_connect_subscribe_disconnect():
    members = {n for n in vars(Transport) if not n.startswith("_")}
    assert {n for n in members if callable(getattr(Transport, n))} == {"connect", "subscribe", "disconnect"}


def test_ingester_exposes_no_publishing_method():
    assert not [n for n in dir(Ingester) if "publish" in n.lower() or n.lower().startswith("send")]
