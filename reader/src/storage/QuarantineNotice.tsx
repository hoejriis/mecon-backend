import { QUARANTINE_MESSAGE, ROLLBACK_GUIDANCE } from './migrations';

/** Shown when the migration runner quarantined the local data. Nothing was deleted. */
export function QuarantineNotice() {
  return (
    <section className="notice" role="alert">
      <p className="update-text">{QUARANTINE_MESSAGE}</p>
      <p className="update-text">{ROLLBACK_GUIDANCE}</p>
    </section>
  );
}
