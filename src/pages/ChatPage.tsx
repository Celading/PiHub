import './Page.css';

export function ChatPage(): React.JSX.Element {
  return (
    <section className="page">
      <h1 className="panel-title">Chat</h1>
      <p className="page-hint">
        Streaming conversation with the pi agent lands here in M3
        (prompt / steer / interrupt / model switch over SSE).
      </p>
    </section>
  );
}
