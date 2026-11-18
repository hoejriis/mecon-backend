export function SkipLink() {
  return (
    <a className="skip-link" href="#main" onClick={(e) => {
      // A hash href would fight the router; move focus to <main> directly.
      e.preventDefault();
      document.getElementById('main')?.focus();
    }}>
      Skip to content
    </a>
  );
}
