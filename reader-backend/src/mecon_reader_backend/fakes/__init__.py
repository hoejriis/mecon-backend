"""Fake adapters for tests and local runs: an in-memory world behind both ports. Never production."""
from .core import FakeReaderCore
from .lookup import FakeSessionLookup
from .observations import FakeObservationScope, FakeReceptionStore
from .world import World

__all__ = ["FakeObservationScope", "FakeReaderCore", "FakeReceptionStore", "FakeSessionLookup", "World", "build",
           "build_observations"]


def build(world_description: dict) -> tuple[World, FakeSessionLookup, FakeReaderCore]:
    world = World.from_description(world_description)
    return world, FakeSessionLookup(world), FakeReaderCore(world)


def build_observations(world_description: dict) -> tuple[World, FakeSessionLookup, FakeReaderCore, dict]:
    """The same world, plus the two observation ports: `create_app(lookup, core, cfg, **extra)`."""
    world, lookup, core = build(world_description)
    return world, lookup, core, {"observation_scope": FakeObservationScope(world),
                                 "reception_store": FakeReceptionStore(world)}
