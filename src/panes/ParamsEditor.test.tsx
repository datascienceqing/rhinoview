import { fireEvent, render, screen } from '@testing-library/react';
import type { IndicatorConfig, IndicatorParams } from '@shared/types';
import { DEFAULT_PARAMS } from '../indicators/types';
import { ParamsEditor } from './ParamsEditor';

function editor(config: IndicatorConfig) {
  const onChange = vi.fn<(p: IndicatorParams) => void>();
  render(<ParamsEditor config={config} onChange={onChange} />);
  return onChange;
}

const liquidity: IndicatorConfig = { id: 'q', kind: 'liquidity', params: { ...DEFAULT_PARAMS.liquidity }, color: '#ff9800', visible: true };
const ema: IndicatorConfig = { id: 'e', kind: 'ema', params: { period: 20, source: 'close' }, color: '#2962ff', visible: true };

describe('ParamsEditor select fields', () => {
  it('shows the liquidity Zone and Sweeps selects with the current values and all options', () => {
    editor(liquidity);
    const zone = screen.getByLabelText('Zone') as HTMLSelectElement;
    const sweeps = screen.getByLabelText('Sweeps') as HTMLSelectElement;
    expect(zone.value).toBe('wick');
    expect(sweeps.value).toBe('wicks');
    expect([...zone.options].map((o) => o.value)).toEqual(['wick', 'range']);
    expect([...sweeps.options].map((o) => o.value)).toEqual(['wicks', 'retests', 'both']);
    expect(screen.queryByLabelText('Source')).toBeNull();
  });

  it('applies a select change at once and keeps the numbers and the other select', () => {
    const onChange = editor({ ...liquidity, params: { ...DEFAULT_PARAMS.liquidity, lookback: 7, sweepMode: 'both' } });
    fireEvent.change(screen.getByLabelText('Zone'), { target: { value: 'range' } });
    expect(onChange).toHaveBeenLastCalledWith({ lookback: 7, zoneMode: 'range', sweepMode: 'both', minTouches: 0, maxAge: 300, sweepExtend: 20 });
  });

  it('keeps the select values when a number changes', () => {
    const onChange = editor({ ...liquidity, params: { ...DEFAULT_PARAMS.liquidity, zoneMode: 'range', sweepMode: 'retests' } });
    fireEvent.change(screen.getByLabelText('Pivot lookback', { selector: 'input[type="number"]' }), { target: { value: '5' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ lookback: 5, zoneMode: 'range', sweepMode: 'retests' }));
  });

  it('shows each liquidity number field with its own bounds', () => {
    editor(liquidity);
    const bounds = (label: string) => {
      const input = screen.getByLabelText(label, { selector: 'input[type="number"]' });
      return [input.getAttribute('min'), input.getAttribute('max')];
    };
    expect(bounds('Pivot lookback')).toEqual(['2', '100']);
    expect(bounds('Min touches')).toEqual(['0', '100']);
    expect(bounds('Max age (bars)')).toEqual(['10', '5000']);
    expect(bounds('Sweep length (bars)')).toEqual(['1', '500']);
  });

  it('does not apply an invalid number while a select is set', () => {
    const onChange = editor(liquidity);
    fireEvent.change(screen.getByLabelText('Pivot lookback', { selector: 'input[type="number"]' }), { target: { value: '1' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/between 2 and 100/);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('the moved MA Source select still works and keeps the period', () => {
    const onChange = editor({ ...ema, params: { period: 9, source: 'close' } });
    const source = screen.getByLabelText('Source') as HTMLSelectElement;
    expect([...source.options].map((o) => o.value)).toEqual(['open', 'high', 'low', 'close']);
    fireEvent.change(source, { target: { value: 'high' } });
    expect(onChange).toHaveBeenLastCalledWith({ period: 9, source: 'high' });
  });

  it('a period edit keeps the MA source', () => {
    const onChange = editor({ ...ema, params: { period: 9, source: 'low' } });
    fireEvent.change(screen.getByLabelText('Period', { selector: 'input[type="number"]' }), { target: { value: '12' } });
    expect(onChange).toHaveBeenLastCalledWith({ period: 12, source: 'low' });
  });

  it('an MA without a stored source shows close', () => {
    editor({ ...ema, params: { period: 9 } });
    expect((screen.getByLabelText('Source') as HTMLSelectElement).value).toBe('close');
  });

  it('RSI has no select fields', () => {
    editor({ id: 'r', kind: 'rsi', params: { period: 14 }, color: '#2962ff', visible: true });
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});
