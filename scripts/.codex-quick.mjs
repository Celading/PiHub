const BASE = 'http://127.0.0.1:3001';
const events = [];
await new Promise((resolve) => {
  const ac = new AbortController();
  void (async () => {
    try {
      const res = await fetch(`${BASE}/api/events`, { signal: ac.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line.startsWith('data: ')) {
            const ev = JSON.parse(line.slice(6));
            events.push(ev.type);
            if (ev.type === 'agent_settled') { ac.abort(); resolve(); return; }
          }
        }
      }
    } catch { /* aborted */ }
  })();
  setTimeout(() => { ac.abort(); resolve(); }, 180000);
});
const t0 = Date.now();
const r = await fetch(`${BASE}/api/codex/prompt`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: 'Reply with exactly: quick-ok' }),
});
console.log('HTTP', r.status, 'waited', Date.now() - t0, 'ms');
await new Promise((resolve) => {
  const timer = setInterval(() => {
    if (events[events.length - 1] === 'agent_settled') { clearInterval(timer); resolve(); }
  }, 500);
  setTimeout(() => { clearInterval(timer); resolve(); }, 180000);
});
console.log('events:', JSON.stringify(events));
const msgs = await (await fetch(`${BASE}/api/codex/messages`)).json();
console.log('messages:', msgs.messages.map((m) => m.role).join(','), '| user:', JSON.stringify(msgs.messages.find((m) => m.role === 'user')?.content).slice(0, 60));
