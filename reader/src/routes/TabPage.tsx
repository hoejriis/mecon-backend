import type { TabDef } from '../tabs';

export function TabPage({ tab }: { tab: TabDef }) {
  return (
    <section className="split" aria-labelledby={`h-${tab.id}`}>
      <div className="pane pane-list">
        <h1 id={`h-${tab.id}`}>{tab.listTitle}</h1>
        <div className="empty" role="status">
          <p className="empty-title">{tab.emptyTitle}</p>
          <p className="empty-body">{tab.emptyBody}</p>
        </div>
        {tab.id === 'settings' && (
          <p className="empty-body build-stamp">
            Build: {__BUILD_COMMIT__ ? __BUILD_COMMIT__.slice(0, 12) : 'local'}
          </p>
        )}
      </div>
      <div className="pane pane-detail" aria-label={`${tab.label} detail`}>
        <p className="empty-body">Nothing selected.</p>
      </div>
    </section>
  );
}
