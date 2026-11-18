export function Header() {
  return (
    <header className="app-header">
      <picture>
        <source srcSet="/brand/lockup-dark.svg" media="(prefers-color-scheme: dark)" />
        <img className="lockup" src="/brand/lockup-light.svg" alt="MeshContinuum (MECON)" height="32" />
      </picture>
      <span className="app-name">Reader</span>
    </header>
  );
}
