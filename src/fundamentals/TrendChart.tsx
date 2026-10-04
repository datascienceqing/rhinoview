/**
 * Small inline-SVG charts. No chart library: these are a dozen bars or three short lines,
 * and SVG has nothing to dispose. Colours come from the theme's CSS variables.
 */
import { DASH } from './format';

export interface Series {
  name: string;
  color: string;
  values: (number | null)[];
}

interface Props {
  title: string;
  labels: string[];
  series: Series[];
  kind: 'bar' | 'line';
  format: (v: number | null) => string;
}

const W = 320;
const H = 140;
const PAD = { l: 8, r: 8, t: 10, b: 22 };

export function TrendChart({ title, labels, series, kind, format }: Props) {
  const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  if (all.length === 0) {
    return (
      <figure className="fund-chart" data-testid={`chart-${title}`}>
        <figcaption>{title}</figcaption>
        <p className="fund-unavailable">{DASH} no data</p>
      </figure>
    );
  }
  const lo = Math.min(0, ...all);
  const hi = Math.max(0, ...all);
  const span = hi - lo || 1;
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const y = (v: number) => PAD.t + innerH - ((v - lo) / span) * innerH;
  const n = labels.length;
  const slot = innerW / Math.max(n, 1);
  const x = (i: number) => PAD.l + slot * i + slot / 2;
  const zero = y(0);

  return (
    <figure className="fund-chart" data-testid={`chart-${title}`}>
      <figcaption>
        {title}
        {series.length > 1 && (
          <span className="fund-legend">
            {series.map((s) => (
              <span key={s.name} style={{ color: s.color }}>
                {s.name}
              </span>
            ))}
          </span>
        )}
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}, ${labels[0] ?? ''} to ${labels[n - 1] ?? ''}`}>
        <line className="fund-axis" x1={PAD.l} x2={W - PAD.r} y1={zero} y2={zero} />
        {kind === 'bar' &&
          series.map((s) =>
            s.values.map((v, i) => {
              if (v === null) return null;
              const barW = Math.max(2, slot * 0.6);
              const top = Math.min(y(v), zero);
              return (
                <rect
                  key={`${s.name}-${labels[i]}`}
                  x={x(i) - barW / 2}
                  y={top}
                  width={barW}
                  height={Math.max(1, Math.abs(y(v) - zero))}
                  fill={v < 0 ? 'var(--down)' : s.color}
                >
                  <title>{`${labels[i]}: ${format(v)}`}</title>
                </rect>
              );
            }),
          )}
        {kind === 'line' &&
          series.map((s) => {
            // A null breaks the line: a gap is honest, a point at zero is not.
            const segments: string[] = [];
            let current = '';
            s.values.forEach((v, i) => {
              if (v === null) {
                if (current) segments.push(current);
                current = '';
              } else {
                current += `${current ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
              }
            });
            if (current) segments.push(current);
            return (
              <g key={s.name}>
                {segments.map((d) => (
                  <path key={d} d={d} fill="none" stroke={s.color} strokeWidth={2} />
                ))}
                {s.values.map((v, i) =>
                  v === null ? null : (
                    <circle key={labels[i]} cx={x(i)} cy={y(v)} r={2.5} fill={s.color}>
                      <title>{`${s.name} ${labels[i]}: ${format(v)}`}</title>
                    </circle>
                  ),
                )}
              </g>
            );
          })}
        <text className="fund-axis-label" x={PAD.l} y={H - 6}>
          {labels[0]}
        </text>
        <text className="fund-axis-label" x={W - PAD.r} y={H - 6} textAnchor="end">
          {labels[n - 1]}
        </text>
      </svg>
    </figure>
  );
}
