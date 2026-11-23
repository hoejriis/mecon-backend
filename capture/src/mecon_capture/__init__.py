"""MECON observation capture: a receive-only MQTT ingester and a raw capture archive.

The ingester subscribes and never publishes. Every message it receives is handed, bytes
unchanged, to the archive, which commits it (or a stub of it) to its own SQLite file.
"""

__version__ = "0.1.0"
SUBSCRIPTION_CONTRACT_VERSION = "1.0.0-draft.1"
CAPTURE_CONTRACT_VERSION = "1.0.0-draft.2"
