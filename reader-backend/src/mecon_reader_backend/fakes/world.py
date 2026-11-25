"""An in-memory world for the fake adapters, built from a world description (see worlds.json).

Scoping lives here, as it will in the real core: a user sees their fleet's devices and contacts,
their own identities and conversations, and the channels shared with their fleet. The facade never
scopes anything; the isolation cases pass against the fakes only because this module scopes right.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import itertools
import secrets
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from ..ports import Revocation


def now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(dt: datetime | None) -> str | None:
    return None if dt is None else dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


@dataclass
class User:
    name: str
    id: str
    email: str
    display_name: str
    fleet: str
    devices: list[str]
    identities: list[str]
    role: str = "user"
    observations: str = "available"  # the grant GET /session reports as capabilities.observations


@dataclass
class Session:
    id: str
    credential: str
    user: str
    expires_at: datetime
    revoked: bool = False


@dataclass
class LoginRequest:
    id: str
    user: str | None  # None: no account (no mail was sent)
    expires_at: datetime
    state: str = "pending"  # pending, approved, delivered


@dataclass
class Conversation:
    key: tuple  # ("contact", identity, contact) or ("channel", identity, channel)
    created_at: datetime
    read_mark: int = -1  # seq of the newest message read


@dataclass
class Message:
    id: str
    seq: int
    identity: str
    conv_key: tuple
    direction: str
    text: str
    sender_label: str | None
    observed_at: datetime
    read: bool
    source_path: str = "unknown"
    attempt_id: str | None = None


@dataclass
class Event:
    seq: int
    users: frozenset[str]  # user names allowed to see it
    kind: str
    resource: Any  # a conversation key, an attempt id or a device name, resolved per viewer
    occurred_at: datetime


@dataclass
class ObsReception:
    seq: int  # the reception's position: the observation cursor is made from it
    observer: str
    packet: str
    received_at: datetime
    rssi: int
    snr: float


@dataclass
class LeaseKey:
    key_id: str
    private: Any
    public_b64u: str
    not_before: datetime
    not_after: datetime | None = None  # set when retired


@dataclass
class World:
    fleets: list[str]
    users: dict[str, User]
    devices: dict[str, dict]
    identities: dict[str, dict]
    contacts: dict[str, dict]
    channels: dict[str, dict]
    switches: dict[str, str]
    ids: dict[tuple, str] = field(default_factory=dict)  # (kind, name) -> opaque id
    sessions: dict[str, Session] = field(default_factory=dict)  # by credential
    logins: dict[str, LoginRequest] = field(default_factory=dict)
    conversations: dict[tuple, Conversation] = field(default_factory=dict)
    messages: list[Message] = field(default_factory=list)
    attempts: dict[str, dict] = field(default_factory=dict)  # by attempt id
    attempt_index: dict[tuple, str] = field(default_factory=dict)  # (user, client_attempt_id) -> attempt id
    attempt_requests: dict[str, dict] = field(default_factory=dict)
    attempt_owner: dict[str, str] = field(default_factory=dict)
    events: list[Event] = field(default_factory=list)
    event_seq: int = 0
    retention_floor: int = 0
    lease_keys: list[LeaseKey] = field(default_factory=list)
    revocation_queues: list[asyncio.Queue] = field(default_factory=list)
    # Observations (contracts/observations/v1): present in a world that has an "observers" key.
    observers: dict[str, dict] = field(default_factory=dict)
    packets: dict[str, dict] = field(default_factory=dict)
    obs_receptions: list[ObsReception] = field(default_factory=list)
    obs_seq: int = 0
    obs_floor: int = 0
    observes: bool = False
    csrf_secret: bytes = field(default_factory=lambda: secrets.token_bytes(32))
    reader_origins: tuple[str, ...] = ("https://reader.example.test",)
    login_lifetime: timedelta = timedelta(minutes=15)
    session_lifetime: timedelta = timedelta(hours=12)
    _seq: itertools.count = field(default_factory=lambda: itertools.count(1))

    # ---- construction ----

    @classmethod
    def from_description(cls, desc: dict[str, Any]) -> "World":
        users = {}
        for name, u in desc["users"].items():
            users[name] = User(name, "usr_" + secrets.token_hex(8), u["email"], u["display_name"], u["fleet"],
                               list(u.get("devices", [])), list(u.get("identities", [])), u.get("role", "user"),
                               u.get("observations", "available"))
        w = cls(fleets=list(desc["fleets"]), users=users, devices=dict(desc.get("devices", {})),
                identities=dict(desc.get("identities", {})), contacts=dict(desc.get("contacts", {})),
                channels=dict(desc.get("channels", {})), switches={"sending": "on", "lease_signing": "on"},
                observers=dict(desc.get("observers", {})), packets=dict(desc.get("packets", {})),
                observes="observers" in desc)
        for kind, prefix in (("devices", "dev_"), ("identities", "idn_"), ("contacts", "cnt_"), ("channels", "chn_")):
            for name in getattr(w, kind):
                w.ids[(kind, name)] = prefix + secrets.token_hex(8)
        base = now() - timedelta(hours=1)
        for i, m in enumerate(desc.get("messages", [])):
            key = ("contact", m["identity"], m["peer"]) if "peer" in m else ("channel", m["identity"], m["channel"])
            at = base + timedelta(minutes=i)
            w.conversations.setdefault(key, Conversation(key, at))
            seq = next(w._seq)
            w.messages.append(Message("msg_" + secrets.token_hex(8), seq, m["identity"], key, m["direction"],
                                      m["text"], m.get("sender_label"), at, bool(m.get("read", False))))
        for name in w.observers:
            w.ids[("observers", name)] = "obs_" + secrets.token_hex(8)
        for r in sorted(desc.get("receptions", []), key=lambda r: -r["ago_s"]):  # oldest first
            w.add_reception(r["observer"], r["packet"], r["rssi"], r.get("snr", 0), ago_s=r["ago_s"])
        w.switches.update(desc.get("switches", {}))
        w.switches.update({"sending": "on", "lease_signing": "on"})  # every case starts with both on
        w.add_lease_key()
        return w

    # ---- names and scope ----

    def id_of(self, kind: str, name: str) -> str:
        return self.ids[(kind, name)]

    def name_of(self, kind: str, opaque: str) -> str | None:
        for (k, n), i in self.ids.items():
            if k == kind and i == opaque:
                return n
        return None

    def device_fleet(self, device: str) -> str | None:
        for u in self.users.values():
            if device in u.devices:
                return u.fleet
        return None

    def user_by_id(self, user_id: str) -> User | None:
        return next((u for u in self.users.values() if u.id == user_id), None)

    def visible_channels(self, user: User) -> list[str]:
        return [n for n, c in self.channels.items() if user.fleet in c.get("fleets", [])]

    def visible_contacts(self, user: User) -> list[str]:
        out = []
        for n, c in self.contacts.items():
            if c.get("public") or self.device_fleet(c.get("held_by", "")) == user.fleet:
                out.append(n)
        for key in self.conversations:
            if key[0] == "contact" and key[1] in user.identities and key[2] not in out:
                out.append(key[2])
        return out

    def user_conversations(self, user: User) -> list[Conversation]:
        return [c for k, c in self.conversations.items() if k[1] in user.identities]

    def conversation_id(self, user: User, key: tuple) -> str:
        # Per caller: two callers may see one thread under different ids.
        digest = hashlib.sha256(("|".join((user.id,) + tuple(key))).encode()).hexdigest()[:20]
        return "cnv_" + digest

    def conversation_for(self, user: User, conversation_id: str) -> Conversation | None:
        return next((c for c in self.user_conversations(user) if self.conversation_id(user, c.key) == conversation_id), None)

    def unread(self, conv: Conversation) -> int:
        return sum(1 for m in self.messages if m.conv_key == conv.key and not m.read and m.seq > conv.read_mark)

    # ---- sessions ----

    def mint_session(self, user: str) -> Session:
        cred = secrets.token_urlsafe(32)
        s = Session("ses_" + secrets.token_hex(8), cred, user, now() + self.session_lifetime)
        self.sessions[cred] = s
        return s

    @staticmethod
    def session_ref(session: Session) -> str:
        # The stored reference: a hash of the session record's id, never the cookie value.
        return "sr_" + hashlib.sha256(b"session-ref\x00" + session.id.encode()).hexdigest()[:32]

    def session_by_ref(self, session_ref: str) -> Session | None:
        return next((s for s in self.sessions.values() if self.session_ref(s) == session_ref), None)

    def csrf_for(self, session: Session) -> str:
        return b64u(hmac.new(self.csrf_secret, b"csrf\x00" + session.id.encode(), hashlib.sha256).digest())

    def revoke(self, session: Session, reason: str = "revoked") -> None:
        session.revoked = True
        for q in self.revocation_queues:
            q.put_nowait(Revocation(self.session_ref(session), reason))

    # ---- events ----

    def emit(self, users: set[str], kind: str, resource: Any) -> None:
        self.event_seq += 1
        self.events.append(Event(self.event_seq, frozenset(users), kind, resource, now()))

    def age_out(self) -> None:
        # Every cursor issued so far falls outside retention.
        self.event_seq += 1
        self.retention_floor = self.event_seq
        self.events = [e for e in self.events if e.seq > self.retention_floor]
        self.obs_seq += 1
        self.obs_floor = self.obs_seq
        self.obs_receptions = [r for r in self.obs_receptions if r.seq > self.obs_floor]

    # ---- observations ----

    def add_reception(self, observer: str, packet: str, rssi: int, snr: float = 0, *, ago_s: float = 0) -> ObsReception:
        self.obs_seq += 1
        r = ObsReception(self.obs_seq, observer, packet, now() - timedelta(seconds=ago_s), int(rssi), snr)
        self.obs_receptions.append(r)
        return r

    @staticmethod
    def obs_cursor(seq: int) -> str:
        return f"obc_{seq:08d}"

    def parse_obs_cursor(self, cursor: str) -> int | None:
        if not cursor.startswith("obc_"):
            return None
        try:
            seq = int(cursor[4:], 10)
        except ValueError:
            return None
        if seq < self.obs_floor or seq > self.obs_seq:
            return None
        return seq

    @staticmethod
    def cursor(seq: int) -> str:
        return f"evc_{seq:08d}"

    def parse_cursor(self, cursor: str) -> int | None:
        if not cursor.startswith("evc_"):
            return None
        try:
            seq = int(cursor[4:], 10)
        except ValueError:
            return None
        if seq < self.retention_floor or seq > self.event_seq:
            return None
        return seq

    # ---- lease keys ----

    def add_lease_key(self) -> LeaseKey:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

        priv = Ed25519PrivateKey.generate()
        pub = priv.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        k = LeaseKey("lk_" + secrets.token_hex(6), priv, b64u(pub), now())
        self.lease_keys.append(k)
        return k

    def active_key(self) -> LeaseKey | None:
        return next((k for k in self.lease_keys if k.not_after is None), None)

    def rotate_lease_key(self) -> None:
        for k in self.lease_keys:
            if k.not_after is None:
                k.not_after = now()
        self.add_lease_key()

    def revoke_lease_keys(self) -> None:
        self.lease_keys = []
        self.add_lease_key()
