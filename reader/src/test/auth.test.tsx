import { useEffect } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { AuthProvider, useAuth } from '../auth/AuthContext';
import { PENDING_KEY } from '../auth/pendingLogin';
import { createBackend, empty, fx, json, type Backend } from './backend';

let backend: Backend;
const holder: { v: ReturnType<typeof useAuth> | null } = { v: null };
const probe = () => holder.v!;

function Probe() {
  const auth = useAuth();
  useEffect(() => {
    holder.v = auth;
  });
  return null;
}

function mount(path = '/settings') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Probe />
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
  sessionStorage.clear();
  holder.v = null;
  backend = createBackend();
  vi.stubGlobal('fetch', backend.fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('login', () => {
  it('walks email -> pending -> approved -> signed in, honoring poll_after_ms', async () => {
    backend.on('GET /session', json(fx.error401, 401), json(fx.session));
    backend.on('POST /login', json(fx.loginStarted, 202));
    backend.on('GET /login/' + fx.loginStarted.request_id, json(fx.loginPending), json(fx.loginApproved));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount();

    await user.type(await screen.findByLabelText('Email address'), 'alice@example.invalid');
    // Copy must not reveal whether the address has an account.
    expect(screen.getByText(/If this address has an account, a sign-in link is on its way/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));

    expect(JSON.parse(backend.callsTo('POST /login')[0]!.body!)).toEqual({ email: 'alice@example.invalid' });
    expect(JSON.parse(localStorage.getItem(PENDING_KEY)!)).toEqual({
      request_id: fx.loginStarted.request_id,
      expires_at: fx.loginStarted.expires_at,
    });
    const pollKey = 'GET /login/' + fx.loginStarted.request_id;

    // Real time creeps under shouldAdvanceTime, so assert with margin around 2000 ms.
    await tick(1000);
    expect(backend.count(pollKey)).toBe(0);
    await tick(1500);
    expect(backend.count(pollKey)).toBe(1); // pending
    await tick(1000);
    expect(backend.count(pollKey)).toBe(1);
    await tick(1500);
    expect(backend.count(pollKey)).toBe(2); // approved

    expect(await screen.findByText('Alice (synthetic)')).toBeInTheDocument();
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
    expect(probe().status).toBe('signedIn');
  });

  it('resumes a stored pending request after a reload, without a new POST /login', async () => {
    localStorage.setItem(
      PENDING_KEY,
      JSON.stringify({ request_id: fx.loginStarted.request_id, expires_at: fx.loginStarted.expires_at }),
    );
    backend.on('GET /session', json(fx.error401, 401), json(fx.session));
    backend.on('GET /login/' + fx.loginStarted.request_id, json(fx.loginApproved));
    mount();
    expect(await screen.findByText('Alice (synthetic)')).toBeInTheDocument();
    expect(backend.count('POST /login')).toBe(0);
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('an already signed-in cookie skips login and drops any stale pending request', async () => {
    localStorage.setItem(
      PENDING_KEY,
      JSON.stringify({ request_id: fx.loginStarted.request_id, expires_at: fx.loginStarted.expires_at }),
    );
    backend.on('GET /session', json(fx.session));
    mount();
    expect(await screen.findByText('Alice (synthetic)')).toBeInTheDocument();
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it.each([
    ['delivered', fx.loginDelivered],
    ['expired', fx.loginExpired],
  ])('%s is not a sign-in: clears the request and offers a new link', async (_name, body) => {
    localStorage.setItem(
      PENDING_KEY,
      JSON.stringify({ request_id: fx.loginStarted.request_id, expires_at: fx.loginStarted.expires_at }),
    );
    backend.on('GET /session', json(fx.error401, 401));
    backend.on('GET /login/' + fx.loginStarted.request_id, json(body));
    mount();
    expect(await screen.findByText(/expired or was already used\. Request a new one/)).toBeInTheDocument();
    expect(probe().status).toBe('signedOut');
    expect(backend.count('GET /session')).toBe(1); // never asked for a session
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
    expect(screen.getByLabelText('Email address')).toBeInTheDocument();
  });

  it('survives blocked storage', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    backend.on('GET /session', json(fx.error401, 401));
    backend.on('POST /login', json(fx.loginStarted, 202));
    backend.on('GET /login/' + fx.loginStarted.request_id, json(fx.loginPending));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount();
    await user.type(await screen.findByLabelText('Email address'), 'a@example.invalid');
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    expect(await screen.findByText('Check your email')).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});

describe('signed-in session', () => {
  it('a 401 from any call clears the session and cached data and shows login', async () => {
    backend.on('GET /session', json(fx.session));
    backend.on('GET /devices', json(fx.devicesOne), json(fx.error401, 401));
    mount('/nodes');
    expect(await screen.findByText('Synthetic Companion')).toBeInTheDocument();
    expect(probe().devices.status).toBe('ready');

    await act(() => probe().loadDevices()); // second call -> 401
    await waitFor(() => expect(probe().status).toBe('signedOut'));
    expect(probe().session).toBeNull();
    expect(probe().devices).toEqual({ status: 'idle' });
    expect(screen.queryByText('Synthetic Companion')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Email address')).toBeInTheDocument();
  });

  it('shows a missing battery as unknown, never 0%', async () => {
    const item = { ...fx.devicesOne.items[0]!, battery_pct: null };
    backend.on('GET /session', json(fx.session));
    backend.on('GET /devices', json({ ...fx.devicesOne, items: [item] }));
    mount('/nodes');
    expect(await screen.findByText(/battery unknown/)).toBeInTheDocument();
    expect(screen.queryByText(/0%/)).not.toBeInTheDocument();
  });

  it('shows a known battery value', async () => {
    backend.on('GET /session', json(fx.session));
    backend.on('GET /devices', json(fx.devicesOne));
    mount('/nodes');
    expect(await screen.findByText(/battery 82%/)).toBeInTheDocument();
  });

  it('shows capabilities truthfully, and an unavailable devices capability fetches nothing', async () => {
    backend.on(
      'GET /session',
      json({ ...fx.session, capabilities: { ...fx.session.capabilities, devices: 'forbidden' } }),
    );
    mount('/nodes');
    expect(await screen.findByText('Not permitted')).toBeInTheDocument();
    expect(backend.count('GET /devices')).toBe(0);
  });

  it('settings lists each capability state', async () => {
    backend.on('GET /session', json(fx.session));
    mount('/settings');
    expect(await screen.findByText('Alice (synthetic)')).toBeInTheDocument();
    expect(screen.getByText('devices').nextElementSibling).toHaveTextContent('available');
    expect(screen.getByText('messaging').nextElementSibling).toHaveTextContent('unavailable');
  });

  it('logout sends the CSRF token, then clears everything and shows login', async () => {
    backend.on('GET /session', json(fx.session), json(fx.error401, 401));
    backend.on('POST /logout', empty());
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount('/settings');
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await screen.findByLabelText('Email address');
    const logout = backend.callsTo('POST /logout');
    expect(logout).toHaveLength(1);
    expect(logout[0]!.headers.get('X-CSRF-Token')).toBe(fx.session.csrf_token);
    expect(probe().session).toBeNull();
    expect(probe().devices).toEqual({ status: 'idle' });
  });
});

describe('csrf_failed', () => {
  const newSession = { ...fx.session, csrf_token: 'csrf_synthetic_rotated_0000' };

  it('refetches the session and retries the write exactly once', async () => {
    backend.on('GET /session', json(fx.session), json(newSession));
    backend.on('POST /logout', json(fx.error403, 403), empty());
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount('/settings');
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await screen.findByLabelText('Email address');
    const logout = backend.callsTo('POST /logout');
    expect(logout.map((c) => c.headers.get('X-CSRF-Token'))).toEqual([
      fx.session.csrf_token,
      'csrf_synthetic_rotated_0000',
    ]);
    expect(backend.count('GET /session')).toBe(2);
  });

  it('a second csrf_failed surfaces an error and sends no third request', async () => {
    backend.on('GET /session', json(fx.session), json(newSession));
    backend.on('POST /logout', json(fx.error403, 403));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount('/settings');
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('Could not sign out. Try again.')).toBeInTheDocument();
    await tick(5000);
    expect(backend.count('POST /logout')).toBe(2);
    expect(backend.count('GET /session')).toBe(2);
    expect(probe().status).toBe('signedIn');
  });

  it('a 403 with another code is not retried', async () => {
    backend.on('GET /session', json(fx.session));
    backend.on('POST /logout', json({ ...fx.error403, code: 'forbidden' }, 403));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount('/settings');
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await screen.findByText('Could not sign out. Try again.');
    expect(backend.count('POST /logout')).toBe(1);
  });
});
