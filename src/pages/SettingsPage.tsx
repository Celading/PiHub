import './Page.css';

export function SettingsPage(): React.JSX.Element {
  return (
    <section className="page">
      <h1 className="panel-title">Settings</h1>
      <p className="page-hint">
        Read-only view of agent settings and the model store lands in M5.
      </p>
    </section>
  );
}
