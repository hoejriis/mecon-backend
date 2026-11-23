"""MECON observation processing: turns committed raw captures into deduplicated packets, receptions and hourly aggregates.

Implements contracts/observation-processing/v1. It reads a capture archive (read-only) and writes a store of its own.
"""

__version__ = "0.1.0"
PROCESSING_CONTRACT_VERSION = "1.0.0-draft.1"
