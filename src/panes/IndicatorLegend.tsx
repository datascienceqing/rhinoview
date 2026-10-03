import type { CSSProperties } from 'react';
import type { ComputedIndicator } from './computeCache';
import { buildIndicatorLegend } from './legend';

export interface IndicatorLegendRowProps {
  item: ComputedIndicator;
  hoverTime: number | null;
  /** Absolute top offset in px (pane legends). Omit to flow inline (price pane). */
  top?: number;
}

/** One indicator's name and its value(s) at the crosshair, or at the latest bar when the crosshair is off the chart. */
export function IndicatorLegendRow({ item, hoverTime, top }: IndicatorLegendRowProps) {
  const model = buildIndicatorLegend(item, hoverTime);
  const style: CSSProperties | undefined = top === undefined ? undefined : { top: top + 6 };
  return (
    <div
      className={`indicator-legend${top === undefined ? '' : ' in-pane'}${model.visible ? '' : ' hidden-indicator'}`}
      style={style}
      data-testid={`indicator-legend-${model.id}`}
    >
      <span className="indicator-legend-title">{model.title}</span>
      {model.error && (
        <span className="indicator-legend-error" role="alert">
          {model.error}
        </span>
      )}
      {model.visible &&
        model.lines.map((line) => (
          <span className="legend-item" key={line.key}>
            {line.name && <span className="legend-label">{line.name}</span>}
            <span
              className={line.tone ?? undefined}
              style={line.color ? { color: line.color } : undefined}
              data-testid={`indicator-value-${model.id}-${line.key}`}
            >
              {line.text}
            </span>
          </span>
        ))}
    </div>
  );
}
