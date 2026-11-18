import { lazy, Suspense, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { BUILD_COMMIT } from './buildInfo';
import { Header } from './components/Header';
import { LoginScreen } from './components/LoginScreen';
import { TabBar } from './components/TabBar';
import { MessagingProvider } from './messaging/MessagingContext';
import { ChatsRoutes, ContactsPage } from './routes/ChatsPage';
import { Loading } from './components/States';
import { SkipLink } from './components/SkipLink';
import { TabPage } from './routes/TabPage';
import { runStaleShellCheck } from './staleShell';
import { collectBlockers } from './update/guards';
import { startUpdates } from './update/register';
import { UpdateBanner } from './update/UpdateBanner';
import type { UpdateController } from './update/updateController';
import { TABS } from './tabs';

// Dev-only BLE harness. `import.meta.env.DEV` is a build-time constant, so a
// production build drops this import and the whole BLE module graph with it.
// Read-only BLE probe (/probe/ble): its own lazy chunk, so the main bundle stays BLE-free.
const BleProbePage = lazy(() => import('./ble/probe/BleProbePage'));

const BleDevPage = import.meta.env.DEV ? lazy(() => import('./ble/BleDevPage')) : null;

export function Shell() {
  return (
    <div className="shell">
      <SkipLink />
      <Header />
      <main className="content" id="main" tabIndex={-1}>
        <MessagingProvider>
        <Routes>
          <Route path="/chats/contacts" element={<ContactsPage />} />
          <Route path="/chats/*" element={<ChatsRoutes />} />
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
          {TABS.filter((t) => t.id !== 'chats').map((tab) => (
            <Route key={tab.id} path={tab.path} element={<TabPage tab={tab} />} />
          ))}
          <Route path="*" element={<Navigate to={TABS[0]!.path} replace />} />
        </Routes>
        </MessagingProvider>
      </main>
      <TabBar />
    </div>
  );
}

export function App() {
  const [updates, setUpdates] = useState<UpdateController | null>(null);
  useEffect(() => {
    void startUpdates(BUILD_COMMIT).then((c) => {
      setUpdates(c);
      // A stale shell repairs itself only when nothing can be lost; otherwise the update banner asks.
      return runStaleShellCheck(BUILD_COMMIT, {
        getBlockers: collectBlockers,
        onBlocked: () => c?.noteStaleBlocked(),
        activateWaiting: () => c?.activateWaiting() ?? false,
      });
    });
  }, []);

  // The probe uses no Backend, so it is reachable before sign-in.
  return (
    <>
    <UpdateBanner controller={updates} />
    <Routes>
      <Route
        path="/probe/ble"
        element={
          <Suspense fallback={<Loading />}>
            <BleProbePage />
          </Suspense>
        }
      />
      <Route path="*" element={<AuthGate />} />
    </Routes>
    </>
  );
}

function AuthGate() {
  const { status } = useAuth();
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
