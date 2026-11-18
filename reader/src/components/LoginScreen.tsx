import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { Header } from './Header';
import { SkipLink } from './SkipLink';

export function LoginScreen() {
  const { loginPhase, loginMessage, submitEmail, restartLogin } = useAuth();
  const [email, setEmail] = useState('');

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (email.trim()) void submitEmail(email);
  };

  const waiting = loginPhase === 'waiting';
  return (
    <div className="shell">
      <SkipLink />
      <Header />
      <main className="content login" id="main" tabIndex={-1}>
        <h1>Sign in</h1>
        {waiting ? (
          <div className="state state-empty" role="status">
            <p className="state-title">Check your email</p>
            <p className="state-body">
              If this address has an account, a sign-in link is on its way. Open the link, then
              return here. This page signs in as soon as the link is approved.
            </p>
            <button type="button" className="btn btn-secondary" onClick={restartLogin}>
              Use a different address
            </button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="login-form">
            {loginPhase === 'expired' && loginMessage && (
              <p className="notice" role="alert">
                {loginMessage}
              </p>
            )}
            {loginPhase === 'error' && loginMessage && (
              <p className="notice" role="alert">
                {loginMessage}
              </p>
            )}
            <label htmlFor="login-email">Email address</label>
            <input
              id="login-email"
              type="email"
              autoComplete="email"
              inputMode="email"
              required
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button type="submit" className="btn" disabled={loginPhase === 'sending'}>
              {loginPhase === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
            </button>
            <p className="state-body">
              If this address has an account, a sign-in link is on its way.
            </p>
          </form>
        )}
      </main>
    </div>
  );
}
