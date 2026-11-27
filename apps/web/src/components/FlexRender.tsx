/**
 * A small renderer for the LINE Flex Message subset this bot sends (bubbles, carousels, boxes,
 * text, buttons, images, separators). Development/simulator use only; real rendering is LINE's.
 */
import type { CSSProperties } from 'react';

export type LineAction = { type: string; label?: string; data?: string; uri?: string; initial?: string; min?: string; max?: string; mode?: string };

const SIZES: Record<string, number> = { xxs: 10, xs: 11, sm: 13, md: 14, lg: 16, xl: 18, xxl: 22, '3xl': 28, '4xl': 34, '5xl': 40 };
const GAPS: Record<string, number> = { none: 0, xs: 2, sm: 4, md: 8, lg: 12, xl: 16, xxl: 20 };

function Node({ n, onAction }: { n: any; onAction: (a: LineAction) => void }) {
  switch (n.type) {
    case 'box': {
      const horizontal = n.layout === 'horizontal' || n.layout === 'baseline';
      const style: CSSProperties = {
        display: 'flex',
        flexDirection: horizontal ? 'row' : 'column',
        alignItems: n.layout === 'baseline' ? 'baseline' : undefined,
        gap: GAPS[n.spacing] ?? (horizontal ? 6 : 0),
        flex: n.flex,
        marginTop: GAPS[n.margin],
        paddingBottom: n.paddingBottom === 'none' ? 0 : undefined,
        minWidth: 0,
      };
      return <div style={style}>{n.contents?.map((c: any, i: number) => <Node key={i} n={c} onAction={onAction} />)}</div>;
    }
    case 'text':
      return (
        <div
          style={{
            fontSize: SIZES[n.size] ?? 14,
            fontWeight: n.weight === 'bold' ? 600 : 400,
            color: n.color,
            textAlign: n.align === 'end' ? 'right' : n.align === 'center' ? 'center' : 'left',
            flex: n.flex,
            whiteSpace: n.wrap ? 'pre-wrap' : 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            marginTop: GAPS[n.margin],
            minWidth: 0,
          }}
        >
          {n.text}
        </div>
      );
    case 'separator':
      return <hr style={{ border: 0, borderTop: `1px solid ${n.color ?? '#333'}`, margin: `${GAPS[n.margin] ?? 4}px 0 0`, width: '100%' }} />;
    case 'button':
      return (
        <button
          onClick={() => onAction(n.action)}
          style={{
            minHeight: n.height === 'sm' ? 36 : 44,
            borderRadius: 8,
            border: 0,
            cursor: 'pointer',
            fontWeight: 600,
            background: n.style === 'primary' ? n.color ?? '#06c755' : n.style === 'secondary' ? '#2a2a2e' : 'transparent',
            color: n.style === 'primary' ? '#111' : '#eee',
          }}
        >
          {n.action?.label}
        </button>
      );
    case 'image':
      return <img src={n.url} alt="" style={{ width: '100%', aspectRatio: (n.aspectRatio ?? '1:1').replace(':', '/'), objectFit: 'contain', background: n.backgroundColor }} />;
    default:
      return null;
  }
}

function Bubble({ b, onAction }: { b: any; onAction: (a: LineAction) => void }) {
  const bg = b.styles?.body?.backgroundColor ?? '#fff';
  return (
    <div style={{ width: 260, flex: 'none', borderRadius: 14, overflow: 'hidden', background: bg, color: '#111', border: '1px solid #2c2a30' }}>
      {b.hero && <Node n={b.hero} onAction={onAction} />}
      {b.header && <div style={{ padding: '14px 16px 0' }}><Node n={b.header} onAction={onAction} /></div>}
      {b.body && <div style={{ padding: 16 }}><Node n={b.body} onAction={onAction} /></div>}
      {b.footer && <div style={{ padding: '0 16px 16px' }}><Node n={b.footer} onAction={onAction} /></div>}
    </div>
  );
}

export function FlexRender({ contents, onAction }: { contents: any; onAction: (a: LineAction) => void }) {
  if (contents?.type === 'carousel') {
    return (
      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 6, maxWidth: '100%' }}>
        {contents.contents.map((b: any, i: number) => <Bubble key={i} b={b} onAction={onAction} />)}
      </div>
    );
  }
  return <Bubble b={contents} onAction={onAction} />;
}
