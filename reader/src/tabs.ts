export interface TabDef {
  id: 'chats' | 'nodes' | 'map' | 'tools' | 'settings';
  label: string;
  path: string;
  /** Honest placeholder copy: nothing here is simulated. */
  listTitle: string;
  emptyTitle: string;
  emptyBody: string;
}

export const TABS: readonly TabDef[] = [
  {
    id: 'chats',
    label: 'Chats',
    path: '/chats',
    listTitle: 'Conversations',
    emptyTitle: 'Not connected to a Backend',
    emptyBody: 'Conversations will appear here once the Reader is signed in to a MECON Backend.',
  },
  {
    id: 'nodes',
    label: 'Nodes',
    path: '/nodes',
    listTitle: 'Nodes',
    emptyTitle: 'Not connected to a Backend',
    emptyBody: 'Nodes you are authorized to see will appear here once connected.',
  },
  {
    id: 'map',
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
    emptyTitle: 'Not connected to a Backend',
    emptyBody: 'Account and connection settings will appear here once a Backend is configured.',
  },
];
