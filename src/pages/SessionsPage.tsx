import './Page.css';

export function SessionsPage(): React.JSX.Element {
  return (
    <section className="page">
      <h1 className="panel-title">Sessions</h1>
      <p className="page-hint">
        Historical session browsing (JSONL v3 message-tree rebuild) lands in M4.
      </p>
    </section>
  );
}
