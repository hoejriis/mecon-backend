import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { createApiClient } from '../api/client';
import { AuthContext, type AuthValue } from '../auth/AuthContext';
import { MessagingProvider } from '../messaging/MessagingContext';
import { createBackend, json, sessionWith } from '../test/backend';
import { ChatsList } from '../routes/ChatsPage';
import { Empty, ErrorState, Forbidden, Loading, Offline, Unavailable, useOnline } from './States';

function OnlineProbe() {
  return <p>{useOnline() ? 'on' : 'off'}</p>;
}

describe('state components', () => {
  it('renders each state with its own wording', () => {
    render(
      <>
        <Empty title="E" />
        <Unavailable />
        <Forbidden />
        <Offline />
        <ErrorState body="b" requestId="req_123" />
        <Loading label="Loading things" />
      </>,
    );
    expect(screen.getByText('Not available')).toBeInTheDocument();
    expect(screen.getByText('Not permitted')).toBeInTheDocument();
    expect(screen.getByText('You are offline')).toBeInTheDocument();
    expect(screen.getByText('Request ID: req_123')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.getByText('Loading things…')).toBeInTheDocument();
  });

  it('omits the request id when there is none', () => {
    render(<ErrorState />);
    expect(screen.queryByText(/Request ID/)).not.toBeInTheDocument();
  });

  it('follows online/offline events', () => {
    render(<OnlineProbe />);
    expect(screen.getByText('on')).toBeInTheDocument();
    act(() => {
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByText('off')).toBeInTheDocument();
    act(() => {
      Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.getByText('on')).toBeInTheDocument();
  });
});

describe('ChatsList', () => {
  const mount = (state: 'available' | 'unavailable' | 'forbidden') => {
    const b = createBackend();
    const page = { next_cursor: null, as_of: '2030-01-15T10:00:00Z', items: [] };
    for (const r of ['/conversations?limit=50', '/identities', '/channels']) b.on(`GET ${r}`, json(page));
    const api = createApiClient({
      fetchImpl: b.fetchMock as unknown as typeof fetch,
      initialCapabilities: sessionWith({ messaging: state, send: state, events: 'unavailable' }).capabilities,
    });
    const auth = {
      status: 'signedIn',
      session: sessionWith({ messaging: state, send: state, events: 'unavailable' }),
      api,
    } as unknown as AuthValue;
    return render(
      <MemoryRouter>
        <AuthContext.Provider value={auth}>
          <MessagingProvider pollMs={0}>
            <ChatsList state={state} />
          </MessagingProvider>
        </AuthContext.Provider>
      </MemoryRouter>,
    );
  };

  it('has the four filter chips and no Rooms', async () => {
    mount('available');
    const group = screen.getByRole('group', { name: 'Filter conversations' });
    expect(Array.from(group.querySelectorAll('button')).map((b) => b.textContent)).toEqual([
      'All',
      'Unread',
      'DMs',
      'Channels',
    ]);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Channels' }));
    expect(screen.getByRole('button', { name: 'Channels' })).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByText('No channels')).toBeInTheDocument();
  });

  it('shows unavailable and forbidden honestly, with a Contacts entry', () => {
    mount('unavailable');
    expect(screen.getByText('Not available')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Contacts' })).toHaveAttribute('href', '/chats/contacts');
  });

  it('shows forbidden', () => {
    mount('forbidden');
    expect(screen.getByText('Not permitted')).toBeInTheDocument();
  });
});
