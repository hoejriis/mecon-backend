"""A fake ReaderCore over the in-memory world. It scopes every answer to the caller, as a real core must."""
from __future__ import annotations

import asyncio
import json
import secrets
from datetime import timedelta
from typing import Any

from ..ports import Caller, CoreError, EventBatch, LoginPoll, Page, SendResult
from .world import Conversation, LoginRequest, Message, World, b64u, iso, now

LEASE_LIFETIME = timedelta(days=7)
LEASE_PREFIX = b"MECON-LEASE-1\x00"


def canonical_json(obj: Any) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _offset_page(items: list[dict], cursor: str | None, limit: int) -> tuple[list[dict], str | None]:
    start = 0
    if cursor:
        try:
            start = int(cursor.removeprefix("off_"), 10)
        except ValueError:
            start = 0
    chunk = items[start:start + limit]
    nxt = f"off_{start + limit}" if start + limit < len(items) else None
    return chunk, nxt


class FakeReaderCore:
    def __init__(self, world: World, poll_wait_tick_s: float = 0.02, login_origins: list[str] | None = None):
        self.world = world
        self.tick = poll_wait_tick_s
        self.login_origins = login_origins  # None: the Reader's own origin(s), as the world records them

    def _login_origin_allowed(self, origin: str | None, sec_fetch_site: str | None) -> bool:
        # The core's rule: a listed Origin (trailing "/" stripped) OR Sec-Fetch-Site "same-origin".
        allow = list(self.world.reader_origins) if self.login_origins is None else self.login_origins
        return (origin is not None and origin.rstrip("/") in allow) or sec_fetch_site == "same-origin"

    def _user(self, caller: Caller):
        u = self.world.user_by_id(caller.user_id)
        if u is None:
            raise CoreError("forbidden")
        return u

    # ---- session ----

    async def health(self) -> dict[str, Any]:
        return {"status": "ok", "commit": None}

    async def start_login(self, email: str, *, origin: str | None, sec_fetch_site: str | None) -> dict[str, Any]:
        w = self.world
        if not self._login_origin_allowed(origin, sec_fetch_site):
            raise CoreError("forbidden", "origin_rejected", "origin not allowed")
        user = next((u.name for u in w.users.values() if u.email.lower() == email.lower()), None)
        req = secrets.token_urlsafe(24)
        expires = now() + w.login_lifetime
        # A request for no account is recorded too, so its polls read exactly like a real one's.
        w.logins[req] = LoginRequest(req, user, expires)
        return {"request_id": req, "poll_after_ms": 2000, "expires_at": iso(expires)}

    def approve_login(self, request_id: str) -> None:
        """What opening the mailed link does (out of band)."""
        r = self.world.logins.get(request_id)
        if r is not None and r.user is not None and r.state == "pending":
            r.state = "approved"

    async def poll_login(self, request_id: str) -> LoginPoll:
        w = self.world
        r = w.logins.get(request_id)
        if r is None or r.expires_at <= now():
            return LoginPoll("expired")
        if r.state == "approved":
            r.state = "delivered"
            s = w.mint_session(r.user)
            return LoginPoll("approved", credential=s.credential, expires_at=s.expires_at)
        if r.state == "delivered":
            return LoginPoll("delivered")
        return LoginPoll("pending", poll_after_ms=2000)

    async def logout(self, caller: Caller) -> None:
        for s in self.world.sessions.values():
            if self.world.session_ref(s) == caller.session_ref:
                self.world.revoke(s, "logout")

    # ---- devices and messaging reads ----

    def _device(self, name: str) -> dict:
        d = self.world.devices[name]
        return {"id": self.world.id_of("devices", name), "role": d.get("role", "unknown"), "label": d["label"],
                "capability_evidence": {}, "battery_pct": None,
                "reachability": "online" if d.get("reachable") else "unknown", "observed_at": iso(now())}

    async def list_devices(self, caller: Caller, cursor: str | None, limit: int) -> Page:
        u = self._user(caller)
        items, nxt = _offset_page([self._device(n) for n in u.devices], cursor, limit)
        return Page(items, nxt, now())

    async def list_identities(self, caller: Caller) -> Page:
        u = self._user(caller)
        w = self.world
        items = []
        for n in u.identities:
            i = w.identities[n]
            items.append({"id": w.id_of("identities", n), "display_name": i["display_name"],
                          "public_key_prefix": i["public_key_prefix"],
                          "device_id": w.id_of("devices", i["device"]) if i.get("device") else None,
                          "can_send": bool(i.get("can_send"))})
        return Page(items, None, now())

    def _conversation(self, u, c: Conversation) -> dict:
        w = self.world
        kind, ident, target = c.key
        msgs = [m for m in w.messages if m.conv_key == c.key]
        last = max([m.observed_at for m in msgs], default=c.created_at)
        if kind == "contact":
            tid, title = w.id_of("contacts", target), w.contacts[target]["display_name"]
        else:
            tid, title = w.id_of("channels", target), w.channels[target]["name"]
        return {"id": w.conversation_id(u, c.key), "identity_id": w.id_of("identities", ident),
                "target": {"kind": kind, "id": tid}, "title": title, "unread_count": w.unread(c),
                "last_activity_at": iso(last)}

    async def list_conversations(self, caller: Caller, cursor: str | None, limit: int) -> Page:
        u = self._user(caller)
        convs = sorted((self._conversation(u, c) for c in self.world.user_conversations(u)),
                       key=lambda x: x["last_activity_at"], reverse=True)
        items, nxt = _offset_page(convs, cursor, limit)
        return Page(items, nxt, now())

    def _visible(self, caller: Caller, conversation_id: str) -> tuple[Any, Conversation]:
        u = self._user(caller)
        c = self.world.conversation_for(u, conversation_id)
        if c is None:
            raise CoreError("not_found")
        return u, c

    async def get_conversation(self, caller: Caller, conversation_id: str) -> dict[str, Any]:
        u, c = self._visible(caller, conversation_id)
        return self._conversation(u, c)

    def _message(self, u, m: Message) -> dict:
        w = self.world
        channel = m.conv_key[0] == "channel"
        return {"message_id": m.id, "conversation_id": w.conversation_id(u, m.conv_key),
                "identity_id": None if channel else w.id_of("identities", m.identity),
                "direction": m.direction, "sender_label": m.sender_label, "source_path": m.source_path,
                "observed_at": iso(m.observed_at), "content": {"kind": "text", "text": m.text},
                "attempt_id": m.attempt_id}

    async def list_messages(self, caller: Caller, conversation_id: str, cursor: str | None, limit: int) -> Page:
        u, c = self._visible(caller, conversation_id)
        msgs = sorted((m for m in self.world.messages if m.conv_key == c.key), key=lambda m: m.seq, reverse=True)
        items, nxt = _offset_page([self._message(u, m) for m in msgs], cursor, limit)
        return Page(items, nxt, now())

    async def mark_read(self, caller: Caller, conversation_id: str, up_to: str) -> None:
        u, c = self._visible(caller, conversation_id)
        m = next((m for m in self.world.messages if m.id == up_to and m.conv_key == c.key), None)
        if m is None:
            raise CoreError("invalid", "validation_failed", "up_to is not a message in this conversation")
        if m.seq > c.read_mark:
            c.read_mark = m.seq
            self.world.emit({u.name}, "conversation", c.key)

    async def list_contacts(self, caller: Caller, cursor: str | None, limit: int) -> Page:
        u = self._user(caller)
        w = self.world
        items = []
        for n in w.visible_contacts(u):
            ct = w.contacts[n]
            items.append({"id": w.id_of("contacts", n), "display_name": ct["display_name"],
                          "public_key_prefix": ct["public_key_prefix"], "kind": ct.get("kind", "unknown"),
                          "favourite": False, "last_heard_at": None})
        page, nxt = _offset_page(items, cursor, limit)
        return Page(page, nxt, now())

    async def list_channels(self, caller: Caller) -> Page:
        u = self._user(caller)
        w = self.world
        items = [{"id": w.id_of("channels", n), "name": w.channels[n]["name"],
                  "visibility": w.channels[n]["visibility"], "favourite": False, "hash": None}
                 for n in w.visible_channels(u)]
        return Page(items, None, now())

    # ---- sends ----

    async def create_send_attempt(self, caller: Caller, request: dict[str, Any]) -> SendResult:
        w = self.world
        if w.switches.get("sending") != "on":
            # Before anything is read or recorded.
            raise CoreError("forbidden", "sending_disabled", "Reader sending is switched off", retryable=False)
        u = self._user(caller)
        key = (u.name, request["client_attempt_id"])
        if key in w.attempt_index:
            aid = w.attempt_index[key]
            if canonical_json(w.attempt_requests[aid]) != canonical_json(request):
                raise CoreError("conflict", "conflict", "this attempt id was used with a different request")
            return SendResult(w.attempts[aid], created=False)
        ident = w.name_of("identities", request["identity_id"])
        if ident is None or ident not in u.identities or not w.identities[ident].get("can_send"):
            raise CoreError("forbidden", "forbidden", "this identity cannot send for the caller")
        target = request["target"]
        if target["kind"] == "contact":
            tname = w.name_of("contacts", target["id"])
            if tname is None or tname not in w.visible_contacts(u):
                raise CoreError("invalid", "validation_failed", "unknown target")
        else:
            tname = w.name_of("channels", target["id"])
            if tname is None or tname not in w.visible_channels(u):
                raise CoreError("invalid", "validation_failed", "unknown target")
        conv_key = (target["kind"], ident, tname)
        if conv_key not in w.conversations:
            w.conversations[conv_key] = Conversation(conv_key, now())  # first send creates it, once
            w.emit({u.name}, "conversation", conv_key)
        t = iso(now())
        aid = "att_" + secrets.token_hex(8)
        attempt = {"id": aid, "client_attempt_id": request["client_attempt_id"], "path": "backend",
                   "identity_id": request["identity_id"], "status": "queued",
                   "status_evidence": {"accepted_at": t, "first_transmitted_at": None, "transmissions": 0,
                                       "acked_at": None, "detail": None, "source": "device"},
                   "created_at": t, "updated_at": t}
        w.attempts[aid] = attempt
        w.attempt_index[key] = aid
        w.attempt_requests[aid] = dict(request)
        w.attempt_owner[aid] = u.name
        w.emit({u.name}, "attempt_status", aid)
        return SendResult(attempt, created=True)

    async def get_send_attempt(self, caller: Caller, attempt_id: str) -> dict[str, Any]:
        u = self._user(caller)
        if self.world.attempt_owner.get(attempt_id) != u.name:
            raise CoreError("not_found")
        return self.world.attempts[attempt_id]

    # ---- events ----

    def _envelope(self, u, e) -> dict:
        w = self.world
        if e.kind in ("message", "conversation"):
            rid = w.conversation_id(u, e.resource)
        elif e.kind == "device_status":
            rid = w.id_of("devices", e.resource)
        else:
            rid = e.resource
        return {"event_id": w.cursor(e.seq), "kind": e.kind, "occurred_at": iso(e.occurred_at),
                "resource_id": rid, "version": 1}

    async def read_events(self, caller: Caller, cursor: str | None, wait_s: float) -> EventBatch:
        u = self._user(caller)
        w = self.world
        if cursor is None:
            start = w.event_seq
        else:
            start = w.parse_cursor(cursor)
            if start is None:
                raise CoreError("gone", "cursor_expired", "cursor expired; reload and reconnect without one")
        loop = asyncio.get_running_loop()
        deadline = loop.time() + wait_s
        while True:
            held = [e for e in w.events if e.seq > start and u.name in e.users]
            if held or loop.time() >= deadline:
                return EventBatch([self._envelope(u, e) for e in held], w.cursor(w.event_seq))
            await asyncio.sleep(self.tick)

    def checkpoint(self) -> str:
        return self.world.cursor(self.world.event_seq)

    # ---- leases ----

    def _lease_switch(self) -> None:
        if self.world.switches.get("lease_signing", "on") == "absent":
            raise CoreError("not_found", "not_found", "this Backend does not issue leases")

    async def create_lease(self, caller: Caller) -> dict[str, Any]:
        self._lease_switch()
        w = self.world
        key = w.active_key()
        if w.switches.get("lease_signing") != "on" or key is None:
            raise CoreError("unavailable", "lease_signing_unavailable", "lease signing is unavailable", retryable=False)
        u = self._user(caller)
        sending = w.switches.get("sending") == "on"
        identities = []
        for n in u.identities:
            ops = ["receive"]
            if sending and w.identities[n].get("can_send"):
                ops += ["send.direct", "send.channel"]
            identities.append({"identity_id": w.id_of("identities", n), "operations": ops})
        issued = now()
        expires = issued + LEASE_LIFETIME
        payload = {"lease_id": "lse_" + secrets.token_hex(8), "user_id": u.id, "issued_at": iso(issued),
                   "expires_at": iso(expires), "key_id": key.key_id, "contract_version": "1.0",
                   "identities": identities, "devices": [w.id_of("devices", d) for d in u.devices],
                   "channels": [w.id_of("channels", c) for c in w.visible_channels(u)]}
        body = canonical_json(payload)
        sig = key.private.sign(LEASE_PREFIX + body)
        return {"lease": f"{b64u(body)}.{b64u(sig)}", "expires_at": iso(expires)}

    async def list_lease_keys(self, caller: Caller) -> dict[str, Any]:
        self._lease_switch()
        self._user(caller)
        w = self.world
        horizon = now() - LEASE_LIFETIME
        keys = [{"key_id": k.key_id, "algorithm": "Ed25519", "public_key": k.public_b64u,
                 "status": "active" if k.not_after is None else "retired",
                 "not_before": iso(k.not_before), "not_after": iso(k.not_after)}
                for k in w.lease_keys if k.not_after is None or k.not_after > horizon]
        return {"keys": keys, "as_of": iso(now())}
