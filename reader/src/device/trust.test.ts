import { describe, expect, it } from 'vitest';
import { OP_CLASS, assertOperationAllowed, classesAllowedOn, linkTrustOf } from './trust';
import { MECON_READ_OPS } from './meconIface';

describe('link trust and operation classes', () => {
  it('USB is trusted for reads; BLE is unknown because a browser cannot read the PIN state', () => {
    expect(linkTrustOf('usb')).toBe('trusted');
    expect(linkTrustOf('ble')).toBe('unknown');
  });

  it('every operation the Reader builds is of class read', () => {
    for (const op of MECON_READ_OPS) expect(OP_CLASS[op], op).toBe('read');
  });

  it('an unknown or default-PIN link may be asked for class read only', () => {
    for (const t of ['unknown', 'default-pin'] as const) expect(classesAllowedOn(t)).toEqual(['read']);
  });

  it('refuses every non-read class on an unknown link, and every operation of unknown class', () => {
    for (const [op, cls] of Object.entries(OP_CLASS)) {
      if (cls === 'read') expect(assertOperationAllowed('unknown', op), op).toBe('read');
      else expect(() => assertOperationAllowed('unknown', op), op).toThrow(/class/);
    }
    for (const op of ['device.reboot', 'device.reset', 'message.send', 'job.ack', 'password.set', 'log.erase', 'packet.transmit', 'advert.send', '']) {
      expect(() => assertOperationAllowed('unknown', op), op).toThrow(/no known class/);
    }
  });
});
