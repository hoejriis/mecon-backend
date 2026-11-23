"""Fake adapters for tests and local runs: an in-memory world behind both ports. Never production."""
from .core import FakeReaderCore
from .lookup import FakeSessionLookup
from .world import World

__all__ = ["FakeReaderCore", "FakeSessionLookup", "World", "build"]


def build(world_description: dict) -> tuple[World, FakeSessionLookup, FakeReaderCore]:
    world = World.from_description(world_description)
    return world, FakeSessionLookup(world), FakeReaderCore(world)
