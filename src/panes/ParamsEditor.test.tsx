import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
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

describe('ParamsEditor confluence fields', () => {
  const confluence: IndicatorConfig = {
    id: 'c',
    kind: 'confluence',
    params: { ...DEFAULT_PARAMS.confluence, latch: 'on', latchTime: 1_700_000_000 },
    color: '#00bcd4',
    visible: true,
  };
  const numberBox = (label: string) => screen.getByLabelText(label, { selector: 'input[type="number"]' }) as HTMLInputElement;

  /** The editor with its params kept in state, as the indicator hook does. */
  function Stateful({ initial, onChange }: { initial: IndicatorConfig; onChange: (p: IndicatorParams) => void }) {
    const [config, setConfig] = useState(initial);
    return (
      <ParamsEditor
        config={config}
        onChange={(params) => {
          onChange(params);
          setConfig((c) => ({ ...c, params }));
        }}
      />
    );
  }

  it('shows the mode select before the number fields, and the latch select after them', () => {
    editor(confluence);
    const fields = [...document.querySelectorAll('.param-field > label')].map((l) => l.textContent);
    expect(fields[0]).toBe('Mode');
    expect(fields.at(-1)).toBe('Latch');
    expect((screen.getByLabelText('Mode') as HTMLSelectElement).value).toBe('turn');
  });

  it('shows the turn fields in mode turn, and the breakdown fields in mode breakdown', () => {
    editor(confluence);
    expect(numberBox('Min confluence').value).toBe('1');
    expect(screen.queryByLabelText('Close quality', { selector: 'input[type="number"]' })).toBeNull();
    cleanup();
    editor({ ...confluence, params: { ...DEFAULT_PARAMS.confluence, mode: 'breakdown' } });
    expect(numberBox('Min confluence').value).toBe('3');
    expect(numberBox('Min trigger distance %').value).toBe('0.5');
    expect(numberBox('Close quality').value).toBe('0.5');
  });

  it('keeps the values of the hidden mode through a mode change and a change back', () => {
    const onChange = vi.fn<(p: IndicatorParams) => void>();
    render(<Stateful initial={confluence} onChange={onChange} />);
    fireEvent.change(numberBox('Min confluence'), { target: { value: '4' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ turnMinConfluence: 4, breakdownMinConfluence: 3 }));
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'breakdown' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'breakdown', turnMinConfluence: 4 }));
    expect(numberBox('Min confluence').value).toBe('3');
    fireEvent.change(numberBox('Min confluence'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'turn' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'turn', turnMinConfluence: 4, breakdownMinConfluence: 5 }));
    expect(numberBox('Min confluence').value).toBe('4');
  });

  it('an invalid draft in a hidden field does not block an edit in the other mode', () => {
    const onChange = vi.fn<(p: IndicatorParams) => void>();
    render(<Stateful initial={confluence} onChange={onChange} />);
    fireEvent.change(numberBox('Min confluence'), { target: { value: '99' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/between 1 and 20/);
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'breakdown' } });
    fireEvent.change(numberBox('Close quality'), { target: { value: '0.4' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'breakdown', closeQuality: 0.4, turnMinConfluence: 1 }));
  });

  it('accepts a decimal in a decimal field, with a decimal step', () => {
    const onChange = editor(confluence);
    const tolerance = numberBox('Cluster tolerance %');
    expect(tolerance.getAttribute('step')).toBe('0.05');
    expect(tolerance.getAttribute('inputmode')).toBe('decimal');
    fireEvent.change(tolerance, { target: { value: '0.5' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ tolerancePct: 0.5 }));
  });

  it('rejects a decimal in a whole-number field, and text in a decimal field', () => {
    const first = editor(confluence);
    fireEvent.change(numberBox('Swing lookback'), { target: { value: '25.5' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/whole number/);
    expect(first).not.toHaveBeenCalled();
    cleanup();
    const second = editor(confluence);
    fireEvent.change(numberBox('Volume multiplier'), { target: { value: '1e1' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/must be a number/);
    expect(second).not.toHaveBeenCalled();
  });

  it('keeps latchTime through a number edit and a select change', () => {
    const onChange = editor(confluence);
    fireEvent.change(numberBox('Volume average length'), { target: { value: '20' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ volumeLength: 20, latch: 'on', latchTime: 1_700_000_000 }));
    fireEvent.change(screen.getByLabelText('Latch'), { target: { value: 'off' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ latch: 'off', latchTime: 1_700_000_000 }));
  });
});
