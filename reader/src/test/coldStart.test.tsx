import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { AuthProvider, SESSION_READ_TIMEOUT_MS } from '../auth/AuthContext';
import { OfflineContext, type OfflineValue } from '../offline/OfflineContext';

// A cold start where the app-start GET /session neither fails nor answers (no usable route, half-up network).
const offlineValue: OfflineValue = {
  available: true,
  profiles: [{ userId: 'usr_x', method: 'passkey' }],
  unlockedUserId: null,
  method: null,
  mode: { kind: 'shell', message: 'Offline and locked.' },
  lease: null,
  cache: null,
  quarantined: false,
  warnings: [],
  passkeyPossible: true,
  session: null,
  setup: async () => ({ ok: false, message: null }),
  unlockPasskey: async () => ({ ok: false, message: null }),
  lock: () => undefined,
};

function hangingFetch() {
  return vi.fn((_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }),
  );
}

function mount() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AuthProvider>
        <OfflineContext.Provider value={offlineValue}>
          <App />
        </OfflineContext.Provider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

const setOnLine = (v: boolean) => vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(v);
const unlockHeading = () => screen.queryByRole('heading', { name: 'Unlock your cached messages' });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('cold start with a session read that never answers', () => {
  it('browser reports offline: the locked offline screen shows at once, not after the read gives up', async () => {
    setOnLine(false);
    vi.stubGlobal('fetch', hangingFetch());
    mount();
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(unlockHeading()).not.toBeNull();
  });

  it('browser reports online: the read gives up after the timeout and the locked offline screen shows', async () => {
    setOnLine(true);
    vi.stubGlobal('fetch', hangingFetch());
    mount();
    await act(() => vi.advanceTimersByTimeAsync(SESSION_READ_TIMEOUT_MS - 1000));
    expect(unlockHeading()).toBeNull(); // still waiting
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(unlockHeading()).not.toBeNull();
  });
});
