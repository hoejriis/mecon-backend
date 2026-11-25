"""The facade under test: the Reader API app over the HTTP session-lookup adapter, for the interop run only.

There is no core port adapter, so every core call answers `unavailable`; only what needs the session lookup
(GET /session, the cache, the revocation feed) is meaningful. The lookup cache is set long (default 30 s) on
purpose: the contract allows at most 5 s, and a longer one means a session dropped within the run's bound was
dropped by the revocation feed, not by the cache expiring. Never for deployment.
"""
from __future__ import annotations

import os

from mecon_reader_backend import FacadeConfig, HttpSessionLookup, create_app
from null_core import NullCore


lookup = HttpSessionLookup(os.environ["CORE_LOOKUP_URL"], os.environ["SERVICE_TOKEN_FILE"], timeout_s=2.0)
app = create_app(
    lookup, NullCore(),
    FacadeConfig(reader_origins=tuple(os.environ["READER_ORIGINS"].split(",")),
                 lookup_cache_s=float(os.environ.get("LOOKUP_CACHE_S", "30")), feed_retry_s=0.5,
                 cookie_secure=False))
