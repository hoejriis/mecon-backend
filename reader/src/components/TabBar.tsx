import { NavLink } from 'react-router-dom';
import { TABS } from '../tabs';

export function TabBar() {
  return (
    <nav className="tabbar" aria-label="Main">
      <ul>
        {TABS.map((tab) => (
          <li key={tab.id}>
            <NavLink
              to={tab.path}
              className={({ isActive }) => (isActive ? 'tab tab-active' : 'tab')}
            >
              <span className={`tab-icon tab-icon-${tab.id}`} aria-hidden="true" />
              <span className="tab-label">{tab.label}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
