import type { DetectedDevice } from './detect';
import { scrubText } from './scrub';
import type { LinkTrust } from './trust';

/** The detection result as the probe reports carry it: no keys, ids, names or locations, only what was identified. */
export interface SanitizedDetected {
  summary: string;
  transport: 'usb' | 'ble';
  trust: LinkTrust;
  firmware: 'mecon' | 'unknown';
  firmwareVersion: string | null;
  role: string;
  roleSource: string | null;
  interfaceVersion: string | null;
  carriage: string | null;
  consoleCli: boolean;
  companionBinary: boolean;
  /** The device interface answered hello with `refused`: present, but this link is not trusted. */
  interfaceRefused: boolean;
  capabilities: string[];
  interfaceOps: string[];
  hardware: string | null;
  deviceIdPresent: boolean;
  nodeKeyPresent: boolean;
  evidence: string[];
}

export function sanitizeDetected(d: DetectedDevice): SanitizedDetected {
  const t = (s: string | null): string | null => (s === null ? null : scrubText(s, []));
  return {
    summary: scrubText(d.summary, []),
    transport: d.transport,
    trust: d.trust,
    firmware: d.firmware,
    firmwareVersion: t(d.firmwareVersion),
    role: d.role,
    roleSource: d.roleSource,
    interfaceVersion: d.interfaceVersion,
    carriage: d.carriage,
    consoleCli: d.consoleCli,
    companionBinary: d.companionBinary,
    interfaceRefused: d.interfaceRefused,
    capabilities: [...d.capabilities],
    interfaceOps: d.interfaceOps.map((o) => scrubText(o, [])),
    hardware: t(d.hardware),
    deviceIdPresent: d.deviceIdPresent,
    nodeKeyPresent: d.nodeKeyPresent,
    evidence: d.evidence.map((e) => scrubText(e, [])),
  };
}
