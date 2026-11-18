import { BleError } from '../ble/transport';

/**
 * Link trust and operation classes.
 *
 * What the firmware does with a link, by how it authenticated (hoejriis/mecon-firmware
 * @ 6bfff48c9d3dec9ad8a0219309db2a01c1a3077a, docs/contract/AUTHORITY.md section 3.5 and the
 * section 9 caller table, and the answers on Issue #30 / #5 by the public firmware's owner):
 *  - the USB cable is trusted for reads without a signature;
 *  - a BLE link paired with a PIN other than 0 or 123456 is trusted like the cable;
 *  - a BLE link on a default PIN gets messaging and reads, never secrets or management, and
 *    AUTHORITY.md section 3.5 lists "BLE on a default PIN" among the untrusted callers that are
 *    refused `hello`.
 *
 * Web Bluetooth gives a page no way to read the bond state or the PIN it was paired with, so
 * over BLE the Reader cannot tell the two cases apart. It records that as `unknown` and then
 * behaves as for the weaker one: it requests operations of class `read` and nothing else, and
 * accepts that the device may refuse even `hello`. UNVERIFIED: that no browser exposes the PIN
 * state (none was found in the Web Bluetooth specification text; no browser was tested).
 */
export type LinkTrust = 'trusted' | 'default-pin' | 'unknown';

/** The CLI privilege classes of OPERATIONS.md section 2, plus the two the interface table adds. */
export type OpClass = 'read' | 'write' | 'secret' | 'posture' | 'destructive' | 'reboot' | 'update' | 'signed';

/**
 * Class of the operations the Reader knows by name, from DEVICE_INTERFACE.md section 4 (the
 * "Authorized as" column). An operation not listed here has no known class and is treated as
 * not-read everywhere: it is never requested. `job.ack` is deliberately absent: it is of the
 * read class but releases an owed result, and an unsigned caller is refused it once a record
 * exists (AUTHORITY.md section 9), so the Reader does not request it. `config.get` is a read, and
 * the firmware decides per key what it reveals ("secret keys as the CLI decides").
 */
export const OP_CLASS: Readonly<Record<string, OpClass>> = Object.freeze({
  hello: 'read',
  'status.get': 'read',
  'clock.get': 'read',
  'lora.trace': 'read',
  'config.schema': 'read',
  'config.get': 'read',
  'sub.start': 'read',
  'sub.stop': 'read',
  'deployment.get': 'read',
  'identity.rotation': 'read',
  'job.get': 'read',
  'job.list': 'read',
  'update.manifest': 'read',
  'update.status': 'read',
  'channel.list': 'read',
  'channel.get': 'read',
  'contact.list': 'read',
  'contact.get': 'read',
  'mgmt.channel.get': 'read',
  'config.apply': 'write',
  'channel.put': 'write',
  'channel.remove': 'write',
  'contact.put': 'write',
  'contact.remove': 'write',
  'contact.protect': 'write',
  'deployment.provision': 'write',
  'mgmt.channel.bind': 'write',
  'update.offer': 'update',
  'identity.rotate': 'signed',
});

/** Trust a transport can establish by itself. */
export function linkTrustOf(kind: 'usb' | 'ble'): LinkTrust {
  // The cable is trusted for reads (AUTHORITY.md section 9). Over BLE the PIN is not observable.
  return kind === 'usb' ? 'trusted' : 'unknown';
}

/**
 * Classes the Reader may request on a link of this trust. Today that is `read` on every link,
 * the cable included: the Reader builds no write, secret, posture, reboot or update request
 * at all. A link that is not trusted can never widen this; widening it for a `trusted` link is
 * a deliberate future change with its own tests.
 */
export function classesAllowedOn(trust: LinkTrust): readonly OpClass[] {
  void trust;
  return ['read'];
}

/**
 * Refuses, before anything is written, an operation this link may not be asked for. Used by
 * every request the session sends. The class of an operation the Reader does not know is
 * unknown, and unknown is refused.
 */
export function assertOperationAllowed(trust: LinkTrust, op: string): OpClass {
  const cls = OP_CLASS[op];
  if (!cls) throw new BleError('link_not_trusted', `operation ${op} has no known class; not requested`);
  if (!classesAllowedOn(trust).includes(cls)) {
    throw new BleError('link_not_trusted', `operation ${op} is class ${cls}; a ${trust} link is asked for class read only`);
  }
  return cls;
}
