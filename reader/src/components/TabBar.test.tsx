import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext, type AuthValue } from '../auth/AuthContext';
import { Shell } from '../App';
import { fx } from '../test/backend';

const signedIn: AuthValue = {
  status: 'signedIn',
  session: fx.session as AuthValue['session'],
  devices: { status: 'idle' },
  loginPhase: 'idle',
  loginMessage: null,
  signOutError: null,
  submitEmail: async () => {},
  restartLogin: () => {},
  signOut: async () => {},
  loadDevices: async () => {},
};

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthContext.Provider value={signedIn}>
        <Shell />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe('TabBar', () => {
  it('is a labelled nav landmark with exactly five tabs in order', () => {
    renderAt('/chats');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Chats', 'Nodes', 'Map', 'Tools', 'Settings']);
  });

  it.each([
    ['/chats', 'Chats'],
    ['/nodes', 'Nodes'],
    ['/map', 'Map'],
    ['/tools', 'Tools'],
    ['/settings', 'Settings'],
  ])('marks only %s as aria-current', (path, label) => {
    renderAt(path);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const current = within(nav).getAllByRole('link').filter((l) => l.getAttribute('aria-current') === 'page');
    expect(current.map((l) => l.textContent)).toEqual([label]);
  });

  it('redirects / to Chats', () => {
    renderAt('/');
    expect(screen.getByRole('link', { name: 'Chats' })).toHaveAttribute('aria-current', 'page');
  });

  it('is keyboard operable', async () => {
    const user = userEvent.setup();
    renderAt('/chats');
    const nodes = screen.getByRole('link', { name: 'Nodes' });
    nodes.focus();
    await user.keyboard('{Enter}');
    expect(nodes).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { level: 1, name: 'Nodes' })).toBeInTheDocument();
  });

  it('shows an honest unavailable state for a capability the Backend lacks', () => {
    renderAt('/chats');
    expect(screen.getByText('Not available')).toBeInTheDocument();
  });
});
