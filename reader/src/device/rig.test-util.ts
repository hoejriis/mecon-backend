import { vi } from 'vitest';
import { MockCompanion, type MockCompanionOptions } from '../ble/mockCompanion';
import type { DestinationToken } from './destinations';
import { DeviceSession, type LocalSendAuth, type SessionOptions } from './session';
import { installFakeSerial, type FakeSerialHandle } from './sim/fakeSerial';
import { CompanionSerialPeer, MockRepeater, MockSilentDevice, type CompanionPeerOptions, type SerialPeer } from './sim/serialPeers';
import { WebSerialTransport } from './webSerialTransport';

export const TARGET_ID = 'target_test';
export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function serialRig(peer: SerialPeer, o: { writeTimeoutMs?: number } = {}) {
  const nav: Record<string, unknown> = { userActivation: { isActive: true }, isSecureContext: true };
  const h: FakeSerialHandle = installFakeSerial(nav, peer);
  const bytes = new WebSerialTransport(nav, { writeTimeoutMs: o.writeTimeoutMs ?? 80 });
  return { nav, h, bytes, peer };
}

export function companionRig(o: { mock?: MockCompanionOptions; peer?: CompanionPeerOptions; session?: SessionOptions } = {}) {
  const mock = new MockCompanion(o.mock);
  const peer = new CompanionSerialPeer(mock, o.peer ?? { mecon: true });
  const r = serialRig(peer);
  const backend = { post: vi.fn(async () => undefined) };
  const session = new DeviceSession(r.bytes, {
    detect: { stepTimeoutMs: 150, consoleWindowMs: 150 },
    companion: { responseTimeoutMs: 150, connectTimeoutMs: 150, nowSec: () => 1700000000, backendPath: backend },
    ...o.session,
  });
  return { ...r, mock, peer, session, backend };
}

export function repeaterRig(opts: ConstructorParameters<typeof MockRepeater>[0] = {}) {
  const peer = new MockRepeater(opts);
  const r = serialRig(peer);
  const session = new DeviceSession(r.bytes, { detect: { stepTimeoutMs: 80, consoleWindowMs: 80 } });
  return { ...r, peer, session };
}

export function silentRig(noise = '') {
  const peer = new MockSilentDevice(noise);
  const r = serialRig(peer);
  return { ...r, peer };
}

/** A send authorization for the synthetic Companion (self key 0x11...), valid while the gate is online. */
export const authFor = (op: 'send.direct' | 'send.channel' = 'send.direct', over: Partial<LocalSendAuth> = {}): LocalSendAuth => ({
  op,
  identityId: 'ident_test',
  deviceId: 'dev_test',
  ...(op === 'send.channel' ? { channelId: 'chan_test' } : {}),
  identityKeyPrefix: '111111',
  targetId: TARGET_ID,
  ...over,
});

/** A destination token for a contact, issued by the session's own mapping (prefix `a1a1a1`: Alice). */
export function mapDirect(s: DeviceSession, prefix = 'a1a1a1', pick?: string): DestinationToken {
  const m = s.mapDestination({ kind: 'contact', targetId: TARGET_ID, prefix }, pick);
  if (!m.ok) throw new Error(`test setup: ${m.reason}`);
  return m.token;
}

/** A destination token for a channel (own, uniquely named) by its name on the device. */
export function mapChannel(s: DeviceSession, name = 'Crew'): DestinationToken {
  const m = s.mapDestination({ kind: 'channel', targetId: TARGET_ID, name, ownLinked: true, sameNameCount: 1 });
  if (!m.ok) throw new Error(`test setup: ${m.reason}`);
  return m.token;
}

/** Like mapDirect, but a device that cannot map yields an unusable token, so a test can show the send is refused. */
export function tryMapDirect(s: DeviceSession): DestinationToken {
  const m = s.mapDestination({ kind: 'contact', targetId: TARGET_ID, prefix: 'a1a1a1' });
  return m.ok ? m.token : ({} as DestinationToken);
}
