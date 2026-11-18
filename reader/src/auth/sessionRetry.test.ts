import { SESSION_RETRY_FIRST_MS, SESSION_RETRY_MAX_MS, sessionRetryDelay } from './AuthContext';

describe('sessionRetryDelay', () => {
  it('starts at 5 s, doubles, and is capped at 60 s', () => {
    const seq = [1, 2, 3, 4, 5, 6, 7, 50].map(sessionRetryDelay);
    expect(seq).toEqual([5000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000]);
    expect(SESSION_RETRY_FIRST_MS).toBe(5000);
    expect(SESSION_RETRY_MAX_MS).toBe(60_000);
  });
});
