import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IChartApi } from 'lightweight-charts';
import { FakeChart, FakePane } from './testing/fakeLightweightCharts';
import { VERTICAL_PAN_THRESHOLD_PX, VerticalPan } from './verticalPan';

// jsdom has no PointerEvent: a MouseEvent with the two pointer fields is what the code reads.
function pointer(type: string, x: number, y: number, init: { pointerType?: string; button?: number } = {}): MouseEvent {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: init.button ?? 0 });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  Object.defineProperty(e, 'pointerType', { value: init.pointerType ?? 'mouse' });
  return e;
}

/** Pane 0 occupies x 0-800, y 0-400; its price axis is the right 60 px (x 740-800). */
function placePane(pane: FakePane, top = 0, bottom = 400): void {
  pane.element.getBoundingClientRect = () =>
    ({ top, bottom, left: 0, right: 800, width: 800, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
}

let container: HTMLElement;
let chart: FakeChart;
let pan: VerticalPan;
let onChange: ReturnType<typeof vi.fn>;
const scale = (i = 0) => (chart.paneList[i] as FakePane).priceScale('right');

function drag(from: [number, number], to: [number, number], init: { pointerType?: string } = {}): void {
  container.dispatchEvent(pointer('pointerdown', from[0], from[1], init));
  window.dispatchEvent(pointer('pointermove', to[0], to[1], init));
  window.dispatchEvent(pointer('pointerup', to[0], to[1], init));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  chart = new FakeChart(container, {});
  placePane(chart.paneList[0] as FakePane);
  onChange = vi.fn();
  pan = new VerticalPan(container, chart as unknown as IChartApi, onChange);
});

afterEach(() => {
  pan.dispose();
  container.remove();
});

describe('VerticalPan', () => {
  it('switches the price axis to manual BEFORE the drag moves, so the library can pan it', () => {
    container.dispatchEvent(pointer('pointerdown', 300, 200));
    expect(scale().options().autoScale).toBe(false);
  });

  it('keeps the axis manual after a vertical drag, and reports it', () => {
    drag([300, 200], [300, 200 + VERTICAL_PAN_THRESHOLD_PX + 10]);
    expect(scale().options().autoScale).toBe(false);
    expect(pan.isAutoScaled()).toBe(false);
    expect(onChange).toHaveBeenCalled();
  });

  it('restores auto-scale after a horizontal pan with small vertical jitter', () => {
    drag([300, 200], [100, 200 + VERTICAL_PAN_THRESHOLD_PX - 1]);
    expect(scale().options().autoScale).toBe(true);
  });

  it('restores auto-scale after a plain click', () => {
    drag([300, 200], [300, 200]);
    expect(scale().options().autoScale).toBe(true);
  });

  it('counts the largest vertical excursion, not only where the pointer ends', () => {
    container.dispatchEvent(pointer('pointerdown', 300, 200));
    window.dispatchEvent(pointer('pointermove', 300, 260)); // up and back
    window.dispatchEvent(pointer('pointerup', 300, 201));
    expect(scale().options().autoScale).toBe(false);
  });

  it('ignores a press on the price axis: dragging the axis is the library’s scaling gesture', () => {
    container.dispatchEvent(pointer('pointerdown', 770, 200));
    expect(scale().applyOptions).not.toHaveBeenCalled();
  });

  it('ignores touch and non-primary buttons', () => {
    drag([300, 200], [300, 300], { pointerType: 'touch' });
    container.dispatchEvent(pointer('pointerdown', 300, 200, { button: 2 }));
    expect(scale().applyOptions).not.toHaveBeenCalled();
  });

  it('leaves an axis that was already manual exactly as it was, whatever the drag', () => {
    scale().applyOptions({ autoScale: false });
    scale().applyOptions.mockClear();
    drag([300, 200], [300, 201]);
    expect(scale().applyOptions).not.toHaveBeenCalled();
    expect(scale().options().autoScale).toBe(false);
  });

  it('acts on the pane under the pointer only', () => {
    const second = chart.addPane();
    placePane(second, 400, 600);
    drag([300, 500], [300, 560]);
    expect(scale(1).options().autoScale).toBe(false);
    expect(scale(0).options().autoScale).toBe(true);
  });

  it('resetAutoScale fits every pane again and reports it', () => {
    drag([300, 200], [300, 300]);
    onChange.mockClear();
    pan.resetAutoScale();
    expect(pan.isAutoScaled()).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('reports a double-click, which is how the library resets an axis', () => {
    container.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('stops listening after dispose', () => {
    pan.dispose();
    container.dispatchEvent(pointer('pointerdown', 300, 200));
    expect(scale().applyOptions).not.toHaveBeenCalled();
  });
});
