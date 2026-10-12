/** The production data source of the alert checker: the market service and the shared quote cache. */
import type { QuotesCache } from '../cache/quotesCache';
import type { MarketService } from '../provider/service';
import type { AlertDataSource } from './scheduler';

export function serviceAlertSource(service: MarketService, quotes: QuotesCache): AlertDataSource {
  return {
    async quote(symbol) {
      const hit = quotes.get(symbol);
      if (hit) return { snapshot: hit, cached: true };
      const snapshot = await service.snapshot(symbol);
      quotes.set(symbol, snapshot);
      return { snapshot, cached: false };
    },
    cachedQuote(symbol) {
      return quotes.get(symbol);
    },
    async bars(symbol, timeframe, from, to) {
      return (await service.bars({ symbol, timeframe, from, to, adjusted: true })).bars;
    },
    get delayed() {
      return service.capabilities().delayed;
    },
  };
}
