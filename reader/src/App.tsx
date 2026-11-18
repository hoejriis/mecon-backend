import { Navigate, Route, Routes } from 'react-router-dom';
import { Header } from './components/Header';
import { TabBar } from './components/TabBar';
import { TabPage } from './routes/TabPage';
import { TABS } from './tabs';

export function App() {
  return (
    <div className="shell">
      <Header />
      <main className="content">
        <Routes>
          <Route path="/" element={<Navigate to={TABS[0]!.path} replace />} />
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
