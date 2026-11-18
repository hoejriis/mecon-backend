// Shared by the BLE and USB probe reports (kept out of either probe so neither chunk pulls in the other's transport).
const MAX_TEXT = 160;

/** Removes known sensitive strings and anything shaped like a key, MAC or PIN. */
export function scrubText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 3) out = out.split(s).join('[redacted]');
  }
  out = out
    .replace(/(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}/gi, '[redacted-mac]')
    .replace(/[0-9a-f]{12,}/gi, '[redacted-hex]')
    .replace(/\b\d{6}\b/g, '[redacted-number]');
  return out.length > MAX_TEXT ? `${out.slice(0, MAX_TEXT)}...` : out;
}

