"""A stand-in for the archive's sqlite connection that can fail on demand."""

import sqlite3


class FaultyConnection:
    """Delegates to a real connection. `fail_when(sql, n)` is asked before each statement
    (n counts statements starting with the same first word); True raises an sqlite error."""

    def __init__(self, real, fail_when):
        self._real, self._fail_when, self._seen = real, fail_when, {}

    def execute(self, sql, *args):
        word = sql.split()[0].upper()
        self._seen[word] = self._seen.get(word, 0) + 1
        if self._fail_when(word, self._seen[word]):
            raise sqlite3.OperationalError("injected: database or disk is full")
        return self._real.execute(sql, *args)

    def close(self):
        self._real.close()
