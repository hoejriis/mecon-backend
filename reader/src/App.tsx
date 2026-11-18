import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { BUILD_COMMIT } from './buildInfo';
import { Header } from './components/Header';
import { LoginScreen } from './components/LoginScreen';
import { TabBar } from './components/TabBar';
import { ContactsPage } from './routes/ChatsPage';
import { Loading } from './components/States';
import { SkipLink } from './components/SkipLink';
import { TabPage } from './routes/TabPage';
import { runStaleShellCheck } from './staleShell';
import { TABS } from './tabs';

// Dev-only BLE harness. `import.meta.env.DEV` is a build-time constant, so a
// production build drops this import and the whole BLE module graph with it.
const BleDevPage = import.meta.env.DEV ? lazy(() => import('./ble/BleDevPage')) : null;

export function Shell() {
  return (
    <div className="shell">
      <SkipLink />
      <Header />
      <main className="content" id="main" tabIndex={-1}>
        <Routes>
          <Route path="/chats/contacts" element={<ContactsPage />} />
          <Route path="/" element={<Navigate to={TABS[0]!.path} replace />} />
          {BleDevPage && (
            <Route
              path="/dev/ble"
              element={
                <Suspense fallback={null}>
                  <BleDevPage />
                </Suspense>
              }
            />
          )}
          {TABS.map((tab) => (
            <Route key={tab.id} path={tab.path} element={<TabPage tab={tab} />} />
          ))}
          <Route path="*" element={<Navigate to={TABS[0]!.path} replace />} />
        </Routes>
      </main>
      <TabBar />
    </div>
  );
}

export function App() {
  const { status } = useAuth();

  useEffect(() => {
    void runStaleShellCheck(BUILD_COMMIT);
  }, []);

  if (status === 'loading') {
    return (
      <div className="shell">
        <SkipLink />
        <Header />
        <main className="content" id="main" tabIndex={-1}>
          <div className="pane"><Loading /></div>
        </main>
      </div>
    );
  }
  if (status === 'signedOut') return <LoginScreen />;
  return <Shell />;
}
