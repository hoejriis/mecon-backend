import type { TabDef } from '../tabs';

/*
 * Original tab icons: simple 24px line drawings written for this project.
 * Stroke and fill use currentColor. Shapes marked "fillable" fill when the
 * tab is selected; "cut" strokes switch to the surface colour so detail
 * stays visible inside a filled shape (see app.css).
 */
const common = {
  width: 24,
  height: 24,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
  className: 'tab-svg',
};

function Chats() {
  return (
    <svg {...common}>
      <path className="fillable" d="M6 4h12a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-6l-4.5 3.5V17H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z" />
    </svg>
  );
}

function Nodes() {
  return (
    <svg {...common}>
      <path d="M12 8v4M12 12l-5 4M12 12l5 4" />
      <circle className="fillable" cx="12" cy="5.5" r="2.5" />
      <circle className="fillable" cx="6" cy="18" r="2.5" />
      <circle className="fillable" cx="18" cy="18" r="2.5" />
    </svg>
  );
}

function MapIcon() {
  return (
    <svg {...common}>
      <path className="fillable" d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20z" />
      <path className="cut" d="M9 4v13.5M15 6.5V20" />
    </svg>
  );
}

function Tools() {
  return (
    <svg {...common}>
      <path d="M4 7h16M4 17h16" />
      <circle className="fillable" cx="9" cy="7" r="2.75" />
      <circle className="fillable" cx="15" cy="17" r="2.75" />
    </svg>
  );
}

function Settings() {
  return (
    <svg {...common}>
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1" />
      <circle className="fillable" cx="12" cy="12" r="5.5" />
      <circle className="cut" cx="12" cy="12" r="1.75" />
    </svg>
  );
}

const ICONS: Record<TabDef['id'], () => React.JSX.Element> = {
  chats: Chats,
  nodes: Nodes,
  map: MapIcon,
  tools: Tools,
  settings: Settings,
};

export function TabIcon({ id }: { id: TabDef['id'] }) {
  const Icon = ICONS[id];
  return <Icon />;
}
