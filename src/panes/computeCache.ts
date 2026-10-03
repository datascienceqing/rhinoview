import type { Bar, IndicatorConfig, IndicatorSeries } from '@shared/types';
import type { ComputeIndicator } from '../indicators/types';

/** An indicator ready to draw: its config plus the computed series (null while there is nothing to compute from, or on failure). */
export interface ComputedIndicator {
  config: IndicatorConfig;
  series: IndicatorSeries | null;
  /** Why `series` is null despite there being bars; shown in the editor rather than swallowed. */
  error: string | null;
}

interface Entry {
  bars: readonly Bar[];
  params: IndicatorConfig['params'];
  result: Pick<ComputedIndicator, 'series' | 'error'>;
}

/**
 * Memoises `compute` per indicator id on (bars identity, params identity). That is what
 * makes a parameter edit recompute only the edited indicator, and a colour or visibility
 * toggle recompute nothing: both leave `params` and `bars` untouched. Params are replaced,
 * never mutated, so identity is a sound cache key. Entries for removed ids are evicted.
 */
export class ComputeCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly compute: ComputeIndicator) {}

  resolve(bars: readonly Bar[], configs: readonly IndicatorConfig[]): ComputedIndicator[] {
    const live = new Set<string>();
    const out = configs.map((config) => {
      live.add(config.id);
      const cached = this.entries.get(config.id);
      if (cached && cached.bars === bars && cached.params === config.params) {
        return { config, ...cached.result };
      }
      const result = this.run(bars, config);
      this.entries.set(config.id, { bars, params: config.params, result });
      return { config, ...result };
    });
    for (const id of this.entries.keys()) if (!live.has(id)) this.entries.delete(id);
    return out;
  }

  private run(bars: readonly Bar[], config: IndicatorConfig): Pick<ComputedIndicator, 'series' | 'error'> {
    if (bars.length === 0) return { series: null, error: null };
    try {
      return { series: this.compute(bars, config.kind, config.params), error: null };
    } catch (e) {
      // The editor blocks invalid params, but stored or future-seam params must not take the chart down.
      return { series: null, error: e instanceof Error ? e.message : 'Could not compute indicator' };
    }
  }
}
