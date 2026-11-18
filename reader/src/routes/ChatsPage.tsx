import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { CapabilityState } from '../api/types';
import { Empty, Forbidden, Offline, Unavailable, useOnline } from '../components/States';

/*
 * Filter chips. Rooms is deliberately absent: it is rendered only when a
 * session capability says rooms exist, and the contract has none yet.
 */
const FILTERS = [
  { id: 'all', label: 'All', empty: 'No conversations' },
  { id: 'unread', label: 'Unread', empty: 'No unread conversations' },
  { id: 'dms', label: 'DMs', empty: 'No direct messages' },
  { id: 'channels', label: 'Channels', empty: 'No channels' },
] as const;
type FilterId = (typeof FILTERS)[number]['id'];

export function ChatsList({ state }: { state: CapabilityState }) {
  const [filter, setFilter] = useState<FilterId>('all');
  const online = useOnline();
  const current = FILTERS.find((f) => f.id === filter)!;

  let list;
  if (state === 'forbidden') list = <Forbidden />;
  else if (state !== 'available') {
    list = <Unavailable body="Messaging is not provided by this Backend yet." />;
  } else if (!online) list = <Offline />;
  else {
    list = (
      <Empty title={current.empty} body="Conversations are not shown in this build yet." />
    );
  }

  return (
    <>
      <div className="chip-row" role="group" aria-label="Filter conversations">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className="chip"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <section className="list-region" aria-label={`${current.label} conversations`}>
        {list}
      </section>
      <p className="secondary-link">
        <Link to="/chats/contacts">Contacts</Link>
      </p>
    </>
  );
}

export function ContactsPage() {
  return (
    <section className="split" aria-labelledby="h-contacts">
      <div className="pane pane-list">
        <p className="secondary-link">
          <Link to="/chats">Back to Chats</Link>
        </p>
        <h1 id="h-contacts">Contacts</h1>
        <Unavailable title="Contacts are not available" body="Contacts will appear here once the Backend provides them." />
      </div>
      <section className="pane pane-detail" aria-label="Contact detail">
        <p className="state-body">Nothing selected.</p>
      </section>
    </section>
  );
}
