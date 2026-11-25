"""A core port that answers nothing: the interop facade has no core behind it, only a session lookup."""
from mecon_reader_backend.ports import CoreError


class NullCore:
    async def health(self):
        return {"status": "ok", "commit": None}

    def __getattr__(self, name):
        async def refuse(*a, **k):
            raise CoreError("unavailable")
        return refuse
