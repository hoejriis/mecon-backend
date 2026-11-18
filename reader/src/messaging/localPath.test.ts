import { describe, expect, it } from 'vitest';
import type { Identity, Target } from '../api/types';
import { availablePaths, defaultPath, deviceView, ownsIdentity, type DeviceView } from './localPath';
import { companionRig } from '../device/rig.test-util';

const IDENT: Identity = { id: 'ident_1', display_name: 'Mine', public_key_prefix: '111111', device_id: 'dev_1', can_send: true };
const DM: Target = { kind: 'contact', id: 'c1' };
const CH: Target = { kind: 'channel', id: 'ch1' };
const dev = (over: Partial<DeviceView> = {}): DeviceView => ({
  path: 'usb',
  connected: true,
  capabilities: ['message.send.direct', 'message.send.channel'],
  ownKey: '11'.repeat(32),
  ...over,
});
const base = { sendState: 'available' as const, online: true, devices: [] as DeviceView[], target: DM, identity: IDENT };

describe('send paths: which are offered', () => {
  it('Backend only when send is available AND the Reader is online', () => {
    expect(availablePaths(base)).toEqual(['backend']);
    expect(availablePaths({ ...base, online: false })).toEqual([]);
    expect(availablePaths({ ...base, sendState: 'unavailable' })).toEqual([]);
    expect(availablePaths({ ...base, sendState: 'forbidden' })).toEqual([]);
  });

  it('Bluetooth or USB only with a connected device that has the send operation for the target kind and is the identity’s own', () => {
    expect(availablePaths({ ...base, devices: [dev({ path: 'ble' })] })).toEqual(['backend', 'ble']);
    expect(availablePaths({ ...base, devices: [dev({ path: 'usb' })] })).toEqual(['backend', 'usb']);
    expect(availablePaths({ ...base, devices: [dev({ path: 'ble' }), dev({ path: 'usb' })] })).toEqual(['backend', 'ble', 'usb']);
  });

  it('a device that is not connected is not offered', () => {
    expect(availablePaths({ ...base, devices: [dev({ connected: false })] })).toEqual(['backend']);
  });

  it('capabilities decide: a device without direct send is not offered for a DM; a read-only role has none', () => {
    expect(availablePaths({ ...base, devices: [dev({ capabilities: ['message.send.channel'] })], target: DM })).toEqual(['backend']);
    expect(availablePaths({ ...base, devices: [dev({ capabilities: ['message.send.direct'] })], target: DM })).toEqual(['backend', 'usb']);
    expect(availablePaths({ ...base, devices: [dev({ capabilities: ['identity.read', 'status.read'] })] })).toEqual(['backend']);
  });

  it('a channel target never gets a local path, online or offline, whatever the device can do', () => {
    const both = [dev({ path: 'ble' }), dev({ path: 'usb' })];
    expect(availablePaths({ ...base, devices: both, target: CH })).toEqual(['backend']);
    expect(availablePaths({ ...base, online: false, sendState: 'unavailable', devices: both, target: CH })).toEqual([]);
  });

  it('only the sending identity’s own device is offered', () => {
    expect(availablePaths({ ...base, devices: [dev({ ownKey: 'ab'.repeat(32) })] })).toEqual(['backend']);
    expect(availablePaths({ ...base, devices: [dev({ ownKey: null })] })).toEqual(['backend']);
    expect(availablePaths({ ...base, identity: null, devices: [dev()] })).toEqual(['backend']);
    expect(availablePaths({ ...base, identity: { ...IDENT, public_key_prefix: '' }, devices: [dev()] })).toEqual(['backend']);
    expect(ownsIdentity({ ownKey: '11AA'.padEnd(64, '0') }, { public_key_prefix: '11aa' })).toBe(true); // case-insensitive hex
  });

  it('offline: no Backend, the local path remains (the guard then decides)', () => {
    expect(availablePaths({ ...base, online: false, sendState: 'unavailable', devices: [dev({ path: 'ble' })] })).toEqual(['ble']);
  });
});

describe('send paths: the default is a starting point for the user, nothing more', () => {
  it('Backend when online and offered; the first local path when offline', () => {
    expect(defaultPath(['backend', 'ble', 'usb'], true)).toBe('backend');
    expect(defaultPath(['ble', 'usb'], false)).toBe('ble');
    expect(defaultPath(['usb'], false)).toBe('usb');
    expect(defaultPath([], true)).toBeNull();
  });
  it('online with the Backend not offered: the first local path', () => {
    expect(defaultPath(['usb'], true)).toBe('usb');
  });
});

describe('deviceView from a real session', () => {
  it('a connected synthetic Companion exposes its send capabilities and its own key; a closed link exposes none', async () => {
    const r = companionRig();
    expect(deviceView(r.session)).toMatchObject({ path: 'usb', connected: false, capabilities: [], ownKey: null });
    await r.session.connect();
    const v = deviceView(r.session);
    expect(v).toMatchObject({ path: 'usb', connected: true });
    expect(v.capabilities).toEqual(expect.arrayContaining(['message.send.direct', 'message.send.channel']));
    expect(v.ownKey).toBe('11'.repeat(32));
    expect(availablePaths({ ...base, devices: [v] })).toEqual(['backend', 'usb']);
    r.h.unplug();
    await new Promise((res) => setTimeout(res, 30));
    expect(deviceView(r.session).connected).toBe(false);
    expect(availablePaths({ ...base, devices: [deviceView(r.session)] })).toEqual(['backend']);
    r.session.dispose();
  });
});
