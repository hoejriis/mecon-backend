"""MECON USB Connector: a transparent serial-to-MQTT bridge.

The Connector moves device-signed envelopes between a USB-attached MeshCore
radio and an MQTT broker. It never mints identity, holds keys, decrypts,
inspects or rewrites payloads, fabricates acknowledgements or routes.
"""

__version__ = "0.1.0"
CONTRACT_VERSION = "1.0.0-draft.2"
