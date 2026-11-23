"""A transport that does nothing on the wire and records what the ingester asked of it."""

from mecon_capture.config import Profile


class FakeTransport:
    """Receive-only, like the real seam: connect, subscribe, disconnect. Nothing else."""

    def __init__(self, fail_connect=None):
        self.actions = []
        self.connected_with = []
        self.fail_connect = fail_connect
        self.disconnects = 0

    def connect(self, profile: Profile, client_id: str) -> None:
        if self.fail_connect:
            raise self.fail_connect
        self.connected_with.append((profile.name, client_id))

    def subscribe(self, topic: str, qos: int) -> None:
        self.actions.append({"subscribe": topic, "qos": qos})

    def disconnect(self) -> None:
        self.disconnects += 1

    def take_actions(self):
        a, self.actions = self.actions, []
        return a
