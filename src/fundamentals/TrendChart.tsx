/**
 * Small inline-SVG charts. No chart library: these are a dozen bars or three short lines,
 * and SVG has nothing to dispose. Colours come from the theme's CSS variables.
 */
import { DASH } from './format';
import { useI18n } from '../i18n';

export interface Series {
  name: string;
  color: string;
  values: (number | null)[];
}

interface Props {
  /** Stable in every language: the test id. */
  id: string;
  title: string;
  labels: string[];
  series: Series[];
  kind: 'bar' | 'line';
  format: (v: number | null) => string;
  /** The y-axis labels. Shorter than `format`: a tick is a round number. */
  tick?: (v: number) => string;
}

const W = 320;
const H = 160;
const PAD = { r: 8, t: 10, b: 22 };
const FONT = 9;
/** The gap between a tick label and the plot, and the least gap between two x labels. */
const GAP = 6;

/**
 * Round tick values that include zero and cover [lo, hi]: steps of 1, 2 or 5 x 10^k.
 * About `target` intervals, so a 140 px plot keeps its labels apart.
 */
export function niceTicks(lo: number, hi: number, target = 4): number[] {
  const raw = (hi - lo) / target || 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const ticks: number[] = [];
  for (let i = Math.floor(lo / step); i <= Math.ceil(hi / step); i++) {
    // toPrecision removes the float noise of i * step (0.30000000000000004).
    ticks.push(Number((i * step).toPrecision(12)));
  }
  return ticks;
}

/**
 * An estimate of the text width in SVG units, on the high side: an underestimate clips the
 * y labels at the left edge. A CJK character is about a full em; "%" and "M" are wide.
 */
function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x2e80 ? FONT : /[%MW]/.test(ch) ? FONT * 0.9 : FONT * 0.62;
  return w;
}

export function TrendChart({ id, title, labels, series, kind, format, tick = format }: Props) {
  const { t } = useI18n();
  const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  if (all.length === 0) {
    return (
      <figure className="fund-chart" data-testid={`chart-${id}`}>
        <figcaption>{title}</figcaption>
        <p className="fund-unavailable">
          {DASH} {t('fund.chart.noData')}
        </p>
      </figure>
    );
  }
  const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all));
  const lo = ticks[0] ?? 0;
  const hi = ticks[ticks.length - 1] ?? 0;
  const span = hi - lo || 1;
  const tickText = ticks.map((v) => tick(v));
  // The y labels decide the left margin, so "-1.5B" and "3943亿" both fit.
  const left = Math.max(...tickText.map(textWidth)) + GAP + 2;
  const innerW = W - left - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const y = (v: number) => PAD.t + innerH - ((v - lo) / span) * innerH;
  const n = labels.length;
  const slot = innerW / Math.max(n, 1);
  const x = (i: number) => left + slot * i + slot / 2;
  const zero = y(0);
  // Show every k-th period label so that no two touch. Count from the newest: it always shows.
  const stride = Math.max(1, Math.ceil((Math.max(...labels.map(textWidth)) + GAP) / slot));

  return (
    <figure className="fund-chart" data-testid={`chart-${id}`}>
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
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('fund.chart.range', { title, from: labels[0] ?? '', to: labels[n - 1] ?? '' })}>
        {ticks.map((v, i) => (
          <g key={v} className="fund-y-tick">
            {v !== 0 && <line className="fund-grid" x1={left} x2={W - PAD.r} y1={y(v)} y2={y(v)} />}
            <text className="fund-axis-label" x={left - GAP} y={y(v)} textAnchor="end" dominantBaseline="middle">
              {tickText[i]}
            </text>
          </g>
        ))}
        <line className="fund-axis" x1={left} x2={left} y1={PAD.t} y2={PAD.t + innerH} />
        <line className="fund-axis" x1={left} x2={W - PAD.r} y1={zero} y2={zero} />
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
        {labels.map((label, i) =>
          (n - 1 - i) % stride === 0 ? (
            <text
              key={label}
              className="fund-axis-label fund-x-tick"
              // Keep a long label at either end inside the box.
              x={Math.min(Math.max(x(i), textWidth(label) / 2), W - textWidth(label) / 2)}
              y={H - 6}
              textAnchor="middle"
            >
              {label}
            </text>
          ) : null,
        )}
      </svg>
    </figure>
  );
}
