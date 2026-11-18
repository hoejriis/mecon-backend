import { AMBIGUOUS_LABEL, describeAttempt, type LocalAttempt } from './attemptStatus';
import type { SendStatus } from '../api/types';
import { attempt } from '../test/m2';

const local = (over: Partial<LocalAttempt>): LocalAttempt => ({
  clientAttemptId: 'a',
  draftId: 'd',
  request: {} as LocalAttempt['request'],
  phase: 'accepted',
  attempt: null,
  error: null,
  supersededBy: null,
  createdAt: 0,
  ...over,
});
const server = (status: SendStatus, source: 'device' | 'unsupported' = 'device') =>
  local({ attempt: attempt(status, {}, source) });

describe('describeAttempt', () => {
  it('shows unknown as unknown, never as failed, and says it was not resent', () => {
    for (const a of [server('unknown'), local({ phase: 'ambiguous' })]) {
      const v = describeAttempt(a, 'contact');
      expect(v.label).toBe(AMBIGUOUS_LABEL);
      expect(v.label).toMatch(/unknown/i);
      expect(v.label).toMatch(/not resent/i);
      expect(`${v.label} ${v.detail}`).not.toMatch(/fail/i);
      expect(v.tone).toBe('unknown');
      expect(v.mayHaveTransmitted).toBe(true);
      expect(v.canSendAgain).toBe(true);
    }
  });

  it('failed is failed, and offers a send again that warns it may have been sent', () => {
    const v = describeAttempt(server('failed'), 'contact');
    expect(v.label).toBe('Failed');
    expect(v.tone).toBe('bad');
    expect(v.canSendAgain).toBe(true);
  });

  it('labels acked as delivered to device, never as read', () => {
    const v = describeAttempt(server('acked'), 'contact');
    expect(v.label).toBe('Delivered to device (acknowledged)');
    expect(v.label).not.toMatch(/read|seen/i);
    expect(v.terminal).toBe(true);
  });

  it('transmitted on a channel is final and claims no delivery; on a DM it still awaits an ack', () => {
    expect(describeAttempt(server('transmitted'), 'channel')).toMatchObject({ terminal: true, label: 'Transmitted' });
    expect(describeAttempt(server('transmitted'), 'channel').detail).toMatch(/no delivery confirmation/);
    expect(describeAttempt(server('transmitted'), 'contact').terminal).toBe(false);
  });

  it('timed_out may still have been sent', () => {
    const v = describeAttempt(server('timed_out'), 'contact');
    expect(v.label).toMatch(/Timed out/);
    expect(v.label).toMatch(/may still have been sent/);
    expect(v.canSendAgain).toBe(true);
  });

  it('queued and duty_held are pending/held and offer nothing', () => {
    expect(describeAttempt(server('queued'), 'contact')).toMatchObject({ label: 'Queued', canSendAgain: false });
    expect(describeAttempt(server('duty_held'), 'contact').label).toMatch(/duty/);
    expect(describeAttempt(server('duty_held'), 'contact').canSendAgain).toBe(false);
  });

  it('source unsupported: unknown/timed_out are not given device semantics or a resend offer', () => {
    for (const s of ['unknown', 'timed_out'] as const) {
      const v = describeAttempt(server(s, 'unsupported'), 'contact');
      expect(v.label).toBe('Status not reported');
      expect(v.canSendAgain).toBe(false);
      expect(v.label).not.toMatch(/timed out|outcome unknown/i);
    }
    // failed from a legacy gateway: no claim that it may have transmitted
    expect(describeAttempt(server('failed', 'unsupported'), 'contact').mayHaveTransmitted).toBe(false);
  });

  it('a rejected request is "Not sent"; a 409 key conflict is an internal error with no resend', () => {
    const rej = local({
      phase: 'rejected',
      error: { status: 422, code: 'invalid', message: 'Too long', requestId: 'r', keyConflict: false },
    });
    expect(describeAttempt(rej, 'contact')).toMatchObject({ label: 'Not sent', detail: 'Too long', canSendAgain: true, mayHaveTransmitted: false });
    const conflict = local({
      phase: 'rejected',
      error: { status: 409, code: 'conflict', message: 'm', requestId: null, keyConflict: true },
    });
    expect(describeAttempt(conflict, 'contact')).toMatchObject({ label: 'Not sent — internal error', canSendAgain: false });
  });
});
