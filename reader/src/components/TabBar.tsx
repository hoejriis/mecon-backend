import type { KeyboardEvent } from 'react';
import { NavLink } from 'react-router-dom';
import { TABS } from '../tabs';
import { TabIcon } from './TabIcons';

/** Arrow keys, Home and End move focus between tabs; Enter/Space activate the focused link. */
function onKeyDown(e: KeyboardEvent<HTMLUListElement>) {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  const links = Array.from(e.currentTarget.querySelectorAll<HTMLAnchorElement>('a'));
  const i = links.indexOf(document.activeElement as HTMLAnchorElement);
  if (i < 0) return;
  let next = i;
  if (e.key === 'ArrowRight') next = (i + 1) % links.length;
  if (e.key === 'ArrowLeft') next = (i - 1 + links.length) % links.length;
  if (e.key === 'Home') next = 0;
  if (e.key === 'End') next = links.length - 1;
  e.preventDefault();
  links[next]?.focus();
}

export function TabBar() {
  return (
    <nav className="tabbar" aria-label="Main">
      <ul onKeyDown={onKeyDown}>
        {TABS.map((tab) => (
          <li key={tab.id}>
            <NavLink
              to={tab.path}
              className={({ isActive }) => (isActive ? 'tab tab-active' : 'tab')}
            >
              <TabIcon id={tab.id} />
              <span className="tab-label">{tab.label}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
