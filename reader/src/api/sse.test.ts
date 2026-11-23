import { startEventStream, type ResyncReason } from './eventStream';
import { parseEnvelope, SseParser, type SseItem } from './sse';
import type { EventEnvelope } from './types';
import { envelope } from '../test/m2';

describe('SseParser', () => {
  const feed = (...chunks: string[]) => {
    const p = new SseParser();
    return chunks.flatMap((c) => p.push(c));
  };
  const ev = (e: EventEnvelope, id = e.event_id) => `id: ${id}\ndata: ${JSON.stringify(e)}\n\n`;

  it('reports heartbeat comments, which EventSource would hide', () => {
    expect(feed(': heartbeat\n\n')).toEqual([{ type: 'comment', text: 'heartbeat' }]);
  });

  it('parses an event with id and JSON data', () => {
    const items = feed(ev(envelope('message', 'e1', 'conv_1')));
    expect(items).toHaveLength(1);
    const it0 = items[0] as Extract<SseItem, { type: 'event' }>;
    expect(it0.id).toBe('e1');
    expect(parseEnvelope(it0.data)).toMatchObject({ kind: 'message', resource_id: 'conv_1' });
  });

  it('handles CRLF, bare CR, and a CR/LF pair split across chunks', () => {
    expect(feed('id: 1\r\ndata: a\r\n\r\n')).toMatchObject([{ id: '1', data: 'a' }]);
    // A trailing CR is held back until the next byte shows it is not half of CRLF.
    expect(feed('id: 2\rdata: b\r\r', ': x\n')).toMatchObject([{ id: '2', data: 'b' }, { type: 'comment' }]);
    expect(feed('id: 3\r', '\ndata: c\r', '\n\r', '\n')).toMatchObject([{ id: '3', data: 'c' }]);
  });

  it('reassembles a line split at any byte boundary', () => {
    const text = `: heartbeat\n\n${ev(envelope('conversation', 'e9'))}`;
    for (let i = 1; i < text.length; i++) {
      const items = feed(text.slice(0, i), text.slice(i));
      expect(items.map((x) => x.type)).toEqual(['comment', 'event']);
    }
  });

  it('joins multi-line data, drops a lone field with no data, ignores retry/unknown fields', () => {
    expect(feed('data: a\ndata: b\n\n')).toMatchObject([{ data: 'a\nb' }]);
    expect(feed('id: 5\nretry: 10\nfoo: bar\n\n')).toEqual([]);
    expect(feed('event: update\ndata: x\n\n')).toMatchObject([{ event: 'update' }]);
  });

  it('does not leak an id from one event into the next', () => {
    const items = feed('id: 1\ndata: a\n\ndata: b\n\n') as Array<{ id: string | null }>;
    expect(items.map((i) => i.id)).toEqual(['1', null]);
  });

  it('parseEnvelope rejects non-envelopes and unknown kinds', () => {
    expect(parseEnvelope('nope')).toBeNull();
    expect(parseEnvelope('{"kind":"message"}')).toBeNull();
    expect(parseEnvelope(JSON.stringify(envelope('mystery', 'e')))).toBeNull();
  });
});

/* ---------------------------- stream runner ---------------------------- */

function mkStream() {
  const enc = new TextEncoder();
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
  return {
    res: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    push: (s: string) => ctl.enqueue(enc.encode(s)),
    end: () => { try { ctl.close(); } catch { /* already cancelled */ } },
  };
}

const flush = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
};

interface Harness {
  opens: Array<{ lastEventId: string | null }>;
  events: EventEnvelope[];
  resyncs: ResyncReason[];
  unauthorized: number;
  stop: () => void;
}

function run(answers: Array<() => Response | Promise<Response>>): Harness {
  const h: Harness = { opens: [], events: [], resyncs: [], unauthorized: 0, stop: () => {} };
  let i = 0;
  h.stop = startEventStream({
    open: async ({ lastEventId }) => {
      h.opens.push({ lastEventId });
      const a = answers[Math.min(i++, answers.length - 1)]!;
      return a();
    },
    onEvent: (e) => h.events.push(e),
    onResync: (r) => h.resyncs.push(r),
    onUnauthorized: () => h.unauthorized++,
  });
  return h;
}

describe('startEventStream', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('delivers events and treats heartbeats as liveness (no reconnect while they arrive)', async () => {
    const s = mkStream();
    const h = run([() => s.res]);
    await flush();
    s.push(`id: e1\ndata: ${JSON.stringify(envelope('message', 'e1'))}\n\n`);
    await flush();
    expect(h.events.map((e) => e.event_id)).toEqual(['e1']);
    // 40 s of silence, a heartbeat, 40 s more: 80 s total but never 50 s without bytes.
    await flush(40_000);
    s.push(': heartbeat\n\n');
    await flush(40_000);
    expect(h.opens).toHaveLength(1);
    h.stop();
  });

  it('after two missed heartbeat intervals (50 s of silence) reconnects with Last-Event-ID', async () => {
    const s1 = mkStream();
    const s2 = mkStream();
    const h = run([() => s1.res, () => s2.res]);
    await flush();
    s1.push(`id: e7\ndata: ${JSON.stringify(envelope('conversation', 'e7'))}\n\n`);
    await flush(49_000);
    expect(h.opens).toHaveLength(1);
    await flush(2_000); // past 50 s since the last bytes
    await flush(1_500); // backoff
    expect(h.opens).toHaveLength(2);
    expect(h.opens[0]!.lastEventId).toBeNull();
    expect(h.opens[1]!.lastEventId).toBe('e7');
    h.stop();
  });

  it('uses the envelope event_id when the frame has no id: line', async () => {
    const s1 = mkStream();
    const s2 = mkStream();
    const h = run([() => s1.res, () => s2.res]);
    await flush();
    s1.push(`data: ${JSON.stringify(envelope('message', 'env-42'))}\n\n`);
    await flush();
    s1.end();
    await flush(2000);
    expect(h.opens[1]!.lastEventId).toBe('env-42');
    h.stop();
  });

  it('a 410 drops the cursor, asks for a resync and reconnects without Last-Event-ID', async () => {
    const s1 = mkStream();
    const s3 = mkStream();
    const h = run([
      () => s1.res,
      () => new Response(JSON.stringify({ code: 'cursor_expired', message: 'x', request_id: 'r', retryable: false }), { status: 410 }),
      () => s3.res,
    ]);
    await flush();
    s1.push(`id: e1\ndata: ${JSON.stringify(envelope('message', 'e1'))}\n\n`);
    await flush();
    s1.end();
    await flush(2000); // reconnect with e1, gets 410
    expect(h.opens[1]!.lastEventId).toBe('e1');
    expect(h.resyncs).toEqual(['cursor_expired']);
    await flush(2000);
    expect(h.opens[2]!.lastEventId).toBeNull();
    h.stop();
  });

  it.each(['authorization_changed', 'resync_required'] as const)('%s asks for a resync and is not a data event', async (kind) => {
    const s = mkStream();
    const h = run([() => s.res]);
    await flush();
    s.push(`id: x1\ndata: ${JSON.stringify(envelope(kind, 'x1'))}\n\n`);
    await flush();
    expect(h.resyncs).toEqual([kind]);
    expect(h.events).toEqual([]);
    h.stop();
  });

  it('session_revoked runs the sign-out path, delivers nothing after it, and never reconnects', async () => {
    const s = mkStream();
    const h = run([() => s.res]);
    await flush();
    s.push(
      `id: e1\ndata: ${JSON.stringify(envelope('message', 'e1', 'conv_1'))}\n\n` +
        `data: ${JSON.stringify(envelope('session_revoked', 'e2'))}\n\n` +
        `id: e3\ndata: ${JSON.stringify(envelope('message', 'e3', 'conv_1'))}\n\n`,
    );
    await flush(60_000);
    expect(h.unauthorized).toBe(1);
    expect(h.events.map((e) => e.event_id)).toEqual(['e1']);
    expect(h.resyncs).toEqual([]);
    expect(h.opens).toHaveLength(1);
  });

  it('session_revoked prefers onSessionRevoked over onUnauthorized', async () => {
    const s = mkStream();
    const seen = { revoked: 0, unauthorized: 0, opens: 0 };
    startEventStream({
      open: async () => (seen.opens++, s.res),
      onEvent: () => {},
      onResync: () => {},
      onUnauthorized: () => seen.unauthorized++,
      onSessionRevoked: () => seen.revoked++,
    });
    await flush();
    s.push(`data: ${JSON.stringify(envelope('session_revoked', 'e1'))}\n\n`);
    await flush(60_000);
    expect(seen).toEqual({ revoked: 1, unauthorized: 0, opens: 1 });
  });

  it('a 401 stops the stream and runs the sign-out path; it does not reconnect', async () => {
    const h = run([() => new Response('{}', { status: 401 })]);
    await flush(60_000);
    expect(h.unauthorized).toBe(1);
    expect(h.opens).toHaveLength(1);
  });

  it('backs off after a failure and keeps retrying', async () => {
    const s = mkStream();
    const h = run([() => new Response('no', { status: 503 }), () => s.res]);
    await flush();
    expect(h.opens).toHaveLength(1);
    await flush(3000);
    expect(h.opens).toHaveLength(2);
    h.stop();
  });

  it('stop() ends it and opens nothing more', async () => {
    const s = mkStream();
    const h = run([() => s.res]);
    await flush();
    h.stop();
    s.end();
    await flush(120_000);
    expect(h.opens).toHaveLength(1);
  });

  it('ignores a malformed frame and keeps going', async () => {
    const s = mkStream();
    const h = run([() => s.res]);
    await flush();
    s.push('id: bad\ndata: {not json\n\n');
    s.push(`id: e2\ndata: ${JSON.stringify(envelope('message', 'e2'))}\n\n`);
    await flush();
    expect(h.events.map((e) => e.event_id)).toEqual(['e2']);
    h.stop();
  });
});
