export interface TabDef {
  id: 'chats' | 'nodes' | 'map' | 'tools' | 'settings';
  label: string;
  path: string;
  /** Honest placeholder copy: nothing here is simulated. */
  listTitle: string;
  emptyTitle: string;
  emptyBody: string;
  /** Session capability that gates this tab's content, when there is one. */
  capability?: 'messaging' | 'devices' | 'observations';
}

export const TABS: readonly TabDef[] = [
  {
    id: 'chats',
    capability: 'messaging',
    label: 'Chats',
    path: '/chats',
    listTitle: 'Conversations',
    emptyTitle: 'No conversations yet',
    emptyBody: 'Conversations will appear here once messaging is available for your account.',
  },
  {
    id: 'nodes',
    capability: 'devices',
    label: 'Nodes',
    path: '/nodes',
    listTitle: 'Nodes',
    emptyTitle: 'No nodes',
    emptyBody: 'Nodes you are authorized to see will appear here.',
  },
  {
    id: 'map',
    capability: 'observations',
    label: 'Map',
    path: '/map',
    listTitle: 'Map',
    emptyTitle: 'Map unavailable',
    emptyBody: 'Observer locations will be shown here once connected to a Backend that authorizes them.',
  },
  {
    id: 'tools',
    label: 'Tools',
    path: '/tools',
    listTitle: 'Tools',
    emptyTitle: 'No tools available',
    emptyBody: 'Tools appear only when a connected device or Backend reports a verified capability.',
  },
  {
    id: 'settings',
    label: 'Settings',
    path: '/settings',
    listTitle: 'Settings',
    emptyTitle: 'Account',
    emptyBody: '',
  },
];
