"""Download daily bars from FMP into data/backtest/ for the AI skill backtests.

Reads FMP_API_KEY from .env. The key is only put in the request URL. It is never printed.
"""
import json
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / 'data' / 'backtest'

UNIVERSE = (
    'AAPL MSFT NVDA AMZN GOOGL META TSLA AVGO AMD INTC MU AMAT LRCX KLAC TER STX WDC QCOM '
    'TXN ORCL CRM ADBE CSCO IBM JPM BAC GS MS WFC C V MA AXP CAT DE HON GE BA LMT RTX UNP '
    'UPS XOM CVX COP SLB JNJ PFE MRK LLY UNH ABBV KO PEP PG WMT COST HD MCD NKE DIS NFLX'
).split()


def api_key() -> str:
    for line in (ROOT / '.env').read_text().splitlines():
        if line.startswith('FMP_API_KEY='):
            value = line.split('=', 1)[1].strip()
            if value:
                return value
    sys.exit('FMP_API_KEY is not set in .env')


def fetch(symbol: str, key: str, start: str, end: str) -> list:
    query = urllib.parse.urlencode({'symbol': symbol, 'from': start, 'to': end, 'apikey': key})
    url = f'https://financialmodelingprep.com/stable/historical-price-eod/full?{query}'
    with urllib.request.urlopen(url, timeout=30) as resp:
        return json.load(resp)


def main() -> None:
    key = api_key()
    OUT.mkdir(parents=True, exist_ok=True)
    for symbol in UNIVERSE:
        path = OUT / f'{symbol}.json'
        if path.exists():
            continue
        rows = []
        try:
            # Two halves, so neither request reaches the row cap.
            for start, end in (('2008-01-01', '2017-06-30'), ('2017-07-01', '2026-10-30')):
                rows += fetch(symbol, key, start, end)
                time.sleep(0.3)
        except urllib.error.HTTPError as err:
            print(f'{symbol}: HTTP {err.code}')
            continue
        rows.sort(key=lambda r: r['date'])
        path.write_text(json.dumps(rows))
        print(f'{symbol}: {len(rows)} rows, {rows[0]["date"] if rows else "-"} .. {rows[-1]["date"] if rows else "-"}')


if __name__ == '__main__':
    main()
