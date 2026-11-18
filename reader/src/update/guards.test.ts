import type { LocalAttempt } from '../messaging/attemptStatus';
import { isUncertainAttempt } from '../messaging/attemptStatus';
import type { SendAttempt } from '../api/types';
import { bleAdapterGuard, collectBlockers, hasBlockers, registerUpdateGuard } from './guards';

describe('guard registry', () => {
  it('sums guards and drops one when unregistered', () => {
    const off1 = registerUpdateGuard(() => ({ drafts: 2 }));
    const off2 = registerUpdateGuard(() => ({ uncertainAttempts: 1, bleConnected: true }));
    expect(collectBlockers()).toEqual({ drafts: 2, uncertainAttempts: 1, bleConnected: true });
    off1();
    off2();
    expect(collectBlockers()).toEqual({ drafts: 0, uncertainAttempts: 0, bleConnected: false });
    expect(hasBlockers(collectBlockers())).toBe(false);
  });

  it('each blocker alone blocks', () => {
    expect(hasBlockers({ drafts: 1, uncertainAttempts: 0, bleConnected: false })).toBe(true);
    expect(hasBlockers({ drafts: 0, uncertainAttempts: 1, bleConnected: false })).toBe(true);
    expect(hasBlockers({ drafts: 0, uncertainAttempts: 0, bleConnected: true })).toBe(true);
  });

  it('a BLE adapter blocks while connected or connecting, not when idle/disconnected/unsupported', () => {
    const g = (c: string) => bleAdapterGuard({ getSnapshot: () => ({ bleConnection: c }) })().bleConnected;
    expect([g('connected'), g('requesting')]).toEqual([true, true]);
    expect([g('idle'), g('disconnected'), g('denied'), g('unsupported')]).toEqual([false, false, false, false]);
  });
});

const req = { target: { kind: 'contact', id: 'c' } } as unknown as LocalAttempt['request'];
const att = (status: string, source = 'device'): SendAttempt =>
  ({ status, status_evidence: { source } }) as unknown as SendAttempt;
const base = { clientAttemptId: 'a', draftId: 'd', request: req, error: null, supersededBy: null, createdAt: 0 };
const mk = (phase: LocalAttempt['phase'], attempt: SendAttempt | null = null, over: Partial<LocalAttempt> = {}): LocalAttempt => ({
  ...base,
  phase,
  attempt,
  ...over,
});

describe('isUncertainAttempt', () => {
  it('in flight, ambiguous, unknown and timed out are uncertain', () => {
    expect(isUncertainAttempt(mk('posting'))).toBe(true);
    expect(isUncertainAttempt(mk('ambiguous'))).toBe(true);
    expect(isUncertainAttempt(mk('accepted', att('queued')))).toBe(true);
    expect(isUncertainAttempt(mk('accepted', att('duty_held')))).toBe(true);
    expect(isUncertainAttempt(mk('accepted', att('transmitted')))).toBe(true); // DM awaiting ack
    expect(isUncertainAttempt(mk('accepted', att('unknown')))).toBe(true);
    expect(isUncertainAttempt(mk('accepted', att('timed_out')))).toBe(true);
  });
  it('final outcomes and superseded attempts are not', () => {
    expect(isUncertainAttempt(mk('accepted', att('acked')))).toBe(false);
    expect(isUncertainAttempt(mk('accepted', att('failed')))).toBe(false);
    expect(isUncertainAttempt(mk('rejected'))).toBe(false);
    expect(isUncertainAttempt(mk('ambiguous', null, { supersededBy: 'b' }))).toBe(false);
  });
});
