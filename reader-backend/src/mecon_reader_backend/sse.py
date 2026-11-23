"""Server-sent events framing for GET /events.

Each event is one frame: an `id:` line (the event's cursor, so a reconnect sends it back as
`Last-Event-ID`) and one `data:` line holding the EventEnvelope as JSON. A comment line
(`: heartbeat`) follows the held backlog at once, so a client can tell it has caught up, and then
repeats while idle. The stream closes when its session is revoked (after one `authorization_changed`
envelope, with no `id:`, so nothing private follows), when the session expires, or when the
revocation feed has been down too long to trust.
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import Any, AsyncIterator

from .ports import Caller, CoreError, EventBatch, ReaderCore
from .sessions import SessionResolver

HEARTBEAT = b": heartbeat\n\n"


def frame(envelope: dict[str, Any], with_id: bool = True) -> bytes:
    data = json.dumps(envelope, separators=(",", ":"), ensure_ascii=False)
    head = f"id: {envelope['event_id']}\n" if with_id else ""
    return (head + f"data: {data}\n\n").encode("utf-8")


def revoked_frame(cursor: str) -> bytes:
    env = {"event_id": cursor, "kind": "authorization_changed",
           "occurred_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "resource_id": None, "version": 1}
    return frame(env, with_id=False)


async def event_stream(core: ReaderCore, sessions: SessionResolver, caller: Caller, first: EventBatch, *,
                       heartbeat_s: float, feed_down_close_s: float, tick_s: float = 0.25) -> AsyncIterator[bytes]:
    revoked = sessions.register_stream(caller.session_id)
    try:
        cursor = first.cursor
        for env in first.events:
            yield frame(env)
        yield HEARTBEAT
        last_beat = asyncio.get_running_loop().time()
        while True:
            if revoked.is_set():
                yield revoked_frame(cursor)
                return
            if caller.expires_at <= datetime.now(timezone.utc):
                return
            if sessions.feed_down_for() > feed_down_close_s:
                return
            read = asyncio.ensure_future(core.read_events(caller, cursor, min(tick_s, heartbeat_s)))
            stop = asyncio.ensure_future(revoked.wait())
            done, _ = await asyncio.wait({read, stop}, return_when=asyncio.FIRST_COMPLETED)
            if read not in done:
                read.cancel()
                stop.cancel()
                continue  # revoked: the check at the top closes the stream before anything else is sent
            stop.cancel()
            try:
                batch = read.result()
            except CoreError:
                return  # the cursor aged out mid-stream: the client reconnects and gets the 410
            if revoked.is_set():
                continue
            cursor = batch.cursor
            for env in batch.events:
                yield frame(env)
            now = asyncio.get_running_loop().time()
            if batch.events:
                last_beat = now
            elif now - last_beat >= heartbeat_s:
                yield HEARTBEAT
                last_beat = now
    finally:
        sessions.unregister_stream(caller.session_id, revoked)
