"""Server-sent events framing for GET /events.

Each event is one frame: an `id:` line (the event's cursor, so a reconnect sends it back as
`Last-Event-ID`) and one `data:` line holding the EventEnvelope as JSON. A comment line
(`: heartbeat`) follows the held backlog at once, so a client can tell it has caught up, and then
repeats while idle. The stream closes when its session is revoked (after one `session_revoked`
envelope, with no `id:` and `resource_id` null, so nothing private follows), when the session expires, or when the
revocation feed has been down too long to trust.
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Awaitable, Callable

from .ports import Caller, CoreError, EventBatch, ReaderCore
from .sessions import SessionResolver

HEARTBEAT = b": heartbeat\n\n"


def frame(envelope: dict[str, Any], with_id: bool = True) -> bytes:
    data = json.dumps(envelope, separators=(",", ":"), ensure_ascii=False)
    head = f"id: {envelope['event_id']}\n" if with_id else ""
    return (head + f"data: {data}\n\n").encode("utf-8")


def revoked_frame(cursor: str) -> bytes:
    env = {"event_id": cursor, "kind": "session_revoked",
           "occurred_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "resource_id": None, "version": 1}
    return frame(env, with_id=False)


async def event_stream(core: ReaderCore | None, sessions: SessionResolver, caller: Caller, first: EventBatch, *,
                       heartbeat_s: float, feed_down_close_s: float, tick_s: float = 0.25,
                       read: Callable[[Caller, str | None, float], Awaitable[EventBatch]] | None = None,
                       revoked_frame_for: Callable[[str], bytes] = revoked_frame,
                       gone_frame_for: Callable[[str], bytes] | None = None,
                       forbidden_frame_for: Callable[[str], bytes] | None = None) -> AsyncIterator[bytes]:
    """Frame `first`, then follow the stream with `read` (default: the Reader core's read_events).

    `revoked_frame_for` builds the one frame sent when the session is revoked; `gone_frame_for`, when given,
    builds a frame sent before closing when a read finds the cursor gone (else the stream just closes).
    `forbidden_frame_for`, when given, builds the one frame sent before closing when a read finds the caller's
    rights withdrawn (a read raising CoreError `forbidden`); nothing more is sent after it.
    """
    if read is None:
        assert core is not None
        read = core.read_events
    revoked = sessions.register_stream(caller.session_ref)
    try:
        cursor = first.cursor
        for env in first.events:
            yield frame(env)
        yield HEARTBEAT
        last_beat = asyncio.get_running_loop().time()
        while True:
            if revoked.is_set():
                yield revoked_frame_for(cursor)
                return
            if caller.expires_at <= datetime.now(timezone.utc):
                return
            if sessions.feed_down_for() > feed_down_close_s:
                return
            pending = asyncio.ensure_future(read(caller, cursor, min(tick_s, heartbeat_s)))
            stop = asyncio.ensure_future(revoked.wait())
            done, _ = await asyncio.wait({pending, stop}, return_when=asyncio.FIRST_COMPLETED)
            if pending not in done:
                pending.cancel()
                stop.cancel()
                continue  # revoked: the check at the top closes the stream before anything else is sent
            stop.cancel()
            try:
                batch = pending.result()
            except CoreError as e:
                if e.code == "session_ended":
                    yield revoked_frame_for(cursor)  # the core saw the session end before the revocation feed did
                    return
                if e.kind == "forbidden" and forbidden_frame_for is not None:
                    yield forbidden_frame_for(cursor)  # rights withdrawn mid-stream: said once, then closed
                    return
                if e.kind == "gone" and gone_frame_for is not None:
                    yield gone_frame_for(cursor)
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
        sessions.unregister_stream(caller.session_ref, revoked)
