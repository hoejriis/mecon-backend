#!/usr/bin/env python3
"""Mutation check for the facade's own rules.

Each mutant breaks one rule in the source; the tests must then fail. A control run of the unmutated
tree comes first and must pass, so a failure is never a broken invocation. Every pattern must occur
exactly once. A mutant counts as killed only when a named test fails (a crash or a collection error is
not a kill). The file is compared with its backup to prove the edit changed it, restored afterwards
whatever happens, and compared again; a final control run proves the tree is back.
Run from reader-backend/:   python3 scripts/mutation.py [mutant ids...]
"""
import filecmp
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "src" / "mecon_reader_backend"

MUTANTS = [
    # ---- CSRF and Origin reach the lookup on every write ----
    ("c1", "the CSRF token is dropped when calling the lookup", "app.py",
     [('csrf_token=request.headers.get("x-csrf-token"),', "csrf_token=None,")]),
    ("c2", "the Origin is dropped when calling the lookup", "app.py",
     [('origin=request.headers.get("origin"))', "origin=None)")]),
    ("c3", "the Origin check is bypassed (the Reader's own origin is passed instead)", "app.py",
     [('origin=request.headers.get("origin"))', "origin=cfg.reader_origins[0])")]),
    ("c4", "a write is resolved with purpose=read", "app.py",
     [('answer = await sessions.resolve(credential, "write",', 'answer = await sessions.resolve(credential, "read",')]),
    ("c5", "a write is served from the read cache", "sessions.py",
     [('        if purpose == "read":\n            hit = self._cache.get(credential)',
       '        if purpose in ("read", "write"):\n            hit = self._cache.get(credential)')]),
    ("c6", "the pre-session login Origin check removed", "app.py",
     [('if request.headers.get("origin") not in cfg.reader_origins:', "if False:")]),
    ("c7", "CSRF check removed (fake lookup)", "fakes/lookup.py",
     [("if csrf_token is None or not hmac.compare_digest(csrf_token.encode(), expected.encode()):", "if False:")]),
    ("c8", "CSRF accepted when absent (fake lookup)", "fakes/lookup.py",
     [("if csrf_token is None or not hmac", "if csrf_token is not None and not hmac")]),
    ("c9", "Origin check removed (fake lookup)", "fakes/lookup.py",
     [("if origin is None or origin not in self.world.reader_origins:", "if False:")]),
    # ---- fail closed on the session lookup ----
    ("s1", "core_unavailable served from a cached caller past the cache bound", "sessions.py",
     [("if hit.until > now and not self._expired(hit.caller):", "if not self._expired(hit.caller):")]),
    ("s2", "a lookup error answered as no session (401, cookie cleared) instead of 503", "sessions.py",
     [('            return Denied("core_unavailable")\n        if isinstance(answer, Denied):',
       '            return Denied("unknown")\n        if isinstance(answer, Denied):')]),
    ("s3", "core_unavailable refused as 401 instead of 503", "app.py",
     [('return Refusal(503, "unavailable", "session lookup unavailable", retryable=True)',
       'return Refusal(401, "unauthenticated", "no valid session", clear_cookie=True)')]),
    ("s4", "an expired session served", "sessions.py",
     [('        if self._expired(answer):\n            return Denied("expired")\n', "")]),
    ("s5", "a cached caller served past its expiry", "sessions.py",
     [("if hit.until > now and not self._expired(hit.caller):", "if hit.until > now:")]),
    ("s6", "a malformed lookup answer served", "sessions.py",
     [("        if not caller_is_well_formed(answer):\n", "        if False:\n")]),
    ("s7", "a revocation from the feed leaves the cached caller", "sessions.py",
     [("        self.forget_session(rev.session_id)\n        for ev", "        for ev")]),
    ("s8", "logout leaves the cached caller", "app.py",
     [("        sessions.revoke_local(c.session_id)\n", "")]),
    ("s9", "a 401 does not clear the cookie", "app.py",
     [('return Refusal(401, "unauthenticated", "no valid session", clear_cookie=True)',
       'return Refusal(401, "unauthenticated", "no valid session", clear_cookie=False)')]),
    # ---- idempotency, validation, errors, headers ----
    ("i1", "an Idempotency-Key that differs from client_attempt_id accepted", "app.py",
     [('if key != body["client_attempt_id"]:', "if False:")]),
    ("i2", "a missing Idempotency-Key accepted", "app.py",
     [("        if key is None:\n            raise v.Invalid(\"header.Idempotency-Key\")",
       "        if key is None:\n            key = body[\"client_attempt_id\"]")]),
    ("v1", "a send body is not validated", "app.py",
     [("body = v.send_request(await json_body(request))", "body = await json_body(request)")]),
    ("v2", "a lease request with a body accepted", "app.py",
     [("if await request.body():", "if False:")]),
    ("v3", "the login body is not validated", "app.py",
     [('body = v.login_request(await json_body(request))', 'body = await json_body(request)')]),
    ("e1", "error body missing retryable", "app.py",
     [(', "request_id": request_id, "retryable": r.retryable}', ', "request_id": request_id}')]),
    ("e2", "a core status the operation does not declare is passed on", "app.py",
     [("if status not in DECLARED[op]:", "if False:")]),
    ("h1", "Cache-Control: no-store dropped", "app.py",
     [('    return {"Cache-Control": "no-store"}', "    return {}")]),
    ("h2", "the session cookie is not HttpOnly", "app.py",
     [('secure=secure, httponly=True, samesite="strict")', 'secure=secure, httponly=False, samesite="strict")')]),
    # ---- the event stream ----
    ("e3", "the stream ignores Last-Event-ID", "app.py",
     [('cursor = header if header is not None else request.query_params.get("cursor")',
       'cursor = request.query_params.get("cursor")')]),
    ("e4", "the cursor parameter wins over Last-Event-ID", "app.py",
     [('cursor = header if header is not None else request.query_params.get("cursor")',
       'cursor = request.query_params.get("cursor") or header')]),
    ("e5", "an open stream is not told of its revocation", "sessions.py",
     [("        for ev in self._streams.get(rev.session_id, ()):\n            ev.set()",
       "        for ev in self._streams.get(rev.session_id, ()):\n            pass")]),
    ("e6", "the stream does not close on revocation", "sse.py",
     [("            if revoked.is_set():\n                yield revoked_frame(cursor)\n                return",
       "            if revoked.is_set():\n                await asyncio.sleep(0.05)")]),
    ("e7", "the stream stays open when the revocation feed is down", "sse.py",
     [("            if sessions.feed_down_for() > feed_down_close_s:\n                return",
       "            if False:\n                return")]),
]


def run_tests():
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    try:
        p = subprocess.run([sys.executable, "-m", "pytest", "-q", "-x", "-p", "no:cacheprovider"],
                           cwd=ROOT, capture_output=True, text=True, env=env, timeout=300)
    except subprocess.TimeoutExpired:
        return 124, "(timeout: the suite hung under this mutant)"
    return p.returncode, p.stdout + p.stderr


def main():
    rc, out = run_tests()
    if rc != 0:
        print("control run (unmutated) fails; fix the tests first\n" + out[-2000:])
        return 2
    print("control run: unmutated tree passes")
    only = set(sys.argv[1:])
    todo = [m for m in MUTANTS if not only or m[0] in only]
    survivors = []
    with tempfile.TemporaryDirectory() as tmp:
        for mid, desc, fname, edits in todo:
            path = SRC / fname
            backup = pathlib.Path(tmp) / f"{mid}-{fname.replace('/', '_')}"
            shutil.copy2(path, backup)
            try:
                text = path.read_text()
                for old, new in edits:
                    if text.count(old) != 1:
                        print(f"{mid}: pattern not found exactly once ({text.count(old)}): {old[:60]!r}")
                        survivors.append(mid)
                        break
                    text = text.replace(old, new)
                else:
                    path.write_text(text)
                    if filecmp.cmp(path, backup, shallow=False):
                        print(f"{mid}: the edit did not change the file")
                        survivors.append(mid)
                        continue
                    rc, out = run_tests()
                    failed = [ln for ln in out.splitlines() if ln.startswith("FAILED")]
                    if rc != 0 and failed:
                        print(f"{mid}: killed    {desc}\n        by {failed[0].split(' - ')[0]}")
                    else:
                        survivors.append(mid)
                        why = "SURVIVED" if rc == 0 else f"NO NAMED FAILURE (rc {rc})"
                        print(f"{mid}: {why}  {desc}")
            finally:
                shutil.copy2(backup, path)
                if not filecmp.cmp(path, backup, shallow=False):
                    print(f"{mid}: RESTORE FAILED for {fname}")
                    survivors.append(mid)
    rc, _ = run_tests()
    print("restored; control run " + ("passes" if rc == 0 else "FAILS"))
    total = len(todo)
    print(f"{total - len(set(survivors))} of {total} mutants killed")
    if survivors:
        print("survivors: " + ", ".join(sorted(set(survivors))))
    return 1 if survivors or rc != 0 else 0


if __name__ == "__main__":
    sys.exit(main())
