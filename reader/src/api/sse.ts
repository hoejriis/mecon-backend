import type { EventEnvelope } from './types';

/** One parsed unit of an SSE stream. */
export type SseItem =
  | { type: 'event'; id: string | null; event: string; data: string }
  | { type: 'comment'; text: string };

/**
 * Incremental parser for `text/event-stream`. Unlike EventSource it reports
 * comment lines (`: heartbeat`), which is how the Reader tells an idle stream
 * from a dead one. Handles LF, CRLF and CR line endings and chunk boundaries
 * anywhere, including inside a line or between CR and LF.
 */
export class SseParser {
  private buf = '';
  private data: string[] = [];
  private event = '';
  private id: string | null = null;

  /** Feed a decoded chunk; returns the items completed by it. */
  push(chunk: string): SseItem[] {
    this.buf += chunk;
    const out: SseItem[] = [];
    for (;;) {
      const m = /\r\n|\n|\r/.exec(this.buf);
      if (!m) break;
      // A trailing CR may be the first half of CRLF: wait for the next chunk.
      if (m[0] === '\r' && m.index + 1 === this.buf.length) break;
      const line = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      this.line(line, out);
    }
    return out;
  }

  private line(line: string, out: SseItem[]) {
    if (line === '') {
      if (this.data.length > 0) {
        out.push({
          type: 'event',
          id: this.id,
          event: this.event || 'message',
          data: this.data.join('\n'),
        });
      }
      this.data = [];
      this.event = '';
      this.id = null;
      return;
    }
    if (line.startsWith(':')) {
      out.push({ type: 'comment', text: line.slice(1).trim() });
      return;
    }
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
    else if (field === 'id' && !value.includes('\0')) this.id = value;
    // `retry` and unknown fields are ignored: the Reader owns its backoff.
  }
}

const KINDS = [
  'message',
  'conversation',
  'device_status',
  'attempt_status',
  'authorization_changed',
  'resync_required',
  'session_revoked',
];

/** Parse an event's data as an EventEnvelope; null when it is not one. */
export function parseEnvelope(data: string): EventEnvelope | null {
  try {
    const v: unknown = JSON.parse(data);
    if (!v || typeof v !== 'object') return null;
    const e = v as Partial<EventEnvelope>;
    if (typeof e.event_id !== 'string' || typeof e.kind !== 'string') return null;
    if (!KINDS.includes(e.kind)) return null;
    return e as EventEnvelope;
  } catch {
    return null;
  }
}
