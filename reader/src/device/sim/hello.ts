import type { Envelope } from '../meconIface';

/** SIMULATED hello answer: synthetic ids and keys, no real device. */
export function helloEnvelope(id: string, role: string, o: { firmware?: string; capabilities?: string[]; hardware?: string } = {}): Envelope {
  return {
    v: 1,
    id,
    status: 'ok',
    epoch: 3,
    result: {
      interface: '1.0',
      device_id: 'ab'.repeat(16),
      node_key: 'cd'.repeat(32),
      role,
      hardware: o.hardware ?? 'Synthetic Board',
      firmware: o.firmware ?? 'v1.18.0-mecon.0.0.0-synthetic',
      upstream: 'v1.18.0',
      epoch: 3,
      capabilities: o.capabilities ?? ['hello', 'status.get', 'clock.get', 'config.get', 'sub.start', 'stream.health'],
    },
  };
}
