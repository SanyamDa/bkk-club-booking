export interface ThreadMessage {
  direction: 'in' | 'out';
  kind: string;
  payload: any;
  at: string;
}

/** Plain-text summary of any LINE message, for staff views. */
export function describe(m: ThreadMessage): string {
  const p = m.payload ?? {};
  if (m.direction === 'in') {
    if (m.kind === 'text') return p.text;
    if (m.kind === 'postback') {
      const q = new URLSearchParams(p.data ?? '');
      const a = q.get('a');
      const map: Record<string, string> = {
        book: 'Tapped: Book a table', my: 'Tapped: My booking', host: 'Tapped: Talk to a host', restart: 'Tapped: Start over',
        continue: 'Tapped: Continue', confirm: 'Tapped: Confirm', night: `Chose night ${q.get('d')}`,
        night_pick: `Picked date ${p.params?.date ?? ''}`, pax: `Chose ${q.get('r')} guests`, table: `Chose table ${q.get('t')?.split('_').pop()}`,
      };
      return map[a ?? ''] ?? `Tapped: ${a}`;
    }
    if (m.kind === 'image') return '📷 Image (slip?)';
    if (m.kind === 'follow') return 'Added the club on LINE';
    return `[${m.kind}]`;
  }
  if (p.type === 'text') return p.text;
  if (p.type === 'flex') return `▣ ${p.altText}`;
  if (p.type === 'image') return '▣ QR image';
  return `[${p.type}]`;
}

export function MessageThread({ messages }: { messages: ThreadMessage[] }) {
  if (messages.length === 0) return <p className="faint">No messages yet.</p>;
  return (
    <div className="thread">
      {messages.map((m, i) => (
        <div key={i} className={`bubble ${m.direction}`} title={new Date(m.at).toLocaleString()}>
          {describe(m)}
        </div>
      ))}
    </div>
  );
}
