import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import {
  KEY_STEP_PX,
  MIN_CHART_PX,
  SIDEBAR_DEFAULT_PX,
  SIDEBAR_MAX_PX,
  SIDEBAR_MIN_PX,
  SIDEBAR_WIDTH_KEY,
  SidebarResizer,
  clampSidebarWidth,
  readSidebarWidth,
  useSidebarWidth,
} from './SidebarResizer';
import type { WidthStorage } from './SidebarResizer';

function memoryStorage(initial: Record<string, string> = {}): WidthStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
}

const throwing: () => WidthStorage = () => {
  throw new DOMException('blocked', 'SecurityError');
};

function setViewport(px: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: px });
}

beforeEach(() => setViewport(1440));

/** The hook and the handle together, the way the shell uses them. */
function Harness({ storage }: { storage: () => WidthStorage }) {
  const [width, setWidth] = useSidebarWidth(storage);
  return (
    <>
      <SidebarResizer width={width} onResize={setWidth} controls="side" />
      <aside id="side" data-testid="side" style={{ flexBasis: width }} />
    </>
  );
}

const handle = () => screen.getByRole('separator', { name: 'Resize watchlist' });

// jsdom has no PointerEvent: a MouseEvent with a pointerId is what the handler reads.
function pointer(type: string, clientX: number, button = 0): void {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  act(() => void handle().dispatchEvent(e));
}

describe('clampSidebarWidth', () => {
  it('keeps the width between the limits', () => {
    expect(clampSidebarWidth(100, 1440)).toBe(SIDEBAR_MIN_PX);
    expect(clampSidebarWidth(5000, 1440)).toBe(SIDEBAR_MAX_PX);
    expect(clampSidebarWidth(450.6, 1440)).toBe(451);
  });

  it('leaves the chart its minimum width in a small window', () => {
    expect(clampSidebarWidth(700, 900)).toBe(900 - MIN_CHART_PX);
  });

  it('never goes under the minimum, even in a tiny window', () => {
    expect(clampSidebarWidth(700, 400)).toBe(SIDEBAR_MIN_PX);
  });
});

describe('readSidebarWidth', () => {
  it('uses the default when nothing, garbage, or a throwing storage is there', () => {
    expect(readSidebarWidth(() => memoryStorage())).toBe(SIDEBAR_DEFAULT_PX);
    expect(readSidebarWidth(() => memoryStorage({ [SIDEBAR_WIDTH_KEY]: 'wide' }))).toBe(SIDEBAR_DEFAULT_PX);
    expect(readSidebarWidth(throwing)).toBe(SIDEBAR_DEFAULT_PX);
  });

  it('reads a stored width', () => {
    expect(readSidebarWidth(() => memoryStorage({ [SIDEBAR_WIDTH_KEY]: '480' }))).toBe(480);
  });
});

describe('SidebarResizer', () => {
  it('starts at the stored width, limited to what fits', () => {
    const s = memoryStorage({ [SIDEBAR_WIDTH_KEY]: '9999' });
    render(<Harness storage={() => s} />);
    expect(handle()).toHaveAttribute('aria-valuenow', String(SIDEBAR_MAX_PX));
    expect(screen.getByTestId('side').style.flexBasis).toBe(`${SIDEBAR_MAX_PX}px`);
  });

  it('a drag to the left makes the sidebar wider, and the width is stored on release only', () => {
    const s = memoryStorage();
    render(<Harness storage={() => s} />);
    pointer('pointerdown', 1000);
    pointer('pointermove', 850);
    expect(handle()).toHaveAttribute('aria-valuenow', String(SIDEBAR_DEFAULT_PX + 150));
    expect(s.data[SIDEBAR_WIDTH_KEY]).toBeUndefined();
    pointer('pointerup', 850);
    expect(s.data[SIDEBAR_WIDTH_KEY]).toBe(String(SIDEBAR_DEFAULT_PX + 150));
  });

  it('a drag to the right makes it narrower, down to the minimum', () => {
    const s = memoryStorage();
    render(<Harness storage={() => s} />);
    pointer('pointerdown', 1000);
    pointer('pointermove', 1400);
    pointer('pointerup', 1400);
    expect(handle()).toHaveAttribute('aria-valuenow', String(SIDEBAR_MIN_PX));
  });

  it('ignores a move with no press, and a non-primary button', () => {
    render(<Harness storage={() => memoryStorage()} />);
    pointer('pointermove', 500);
    pointer('pointerdown', 1000, 2);
    pointer('pointermove', 500);
    expect(handle()).toHaveAttribute('aria-valuenow', String(SIDEBAR_DEFAULT_PX));
  });

  it('resizes from the keyboard', () => {
    render(<Harness storage={() => memoryStorage()} />);
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    expect(handle()).toHaveAttribute('aria-valuenow', String(SIDEBAR_DEFAULT_PX + KEY_STEP_PX));
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(handle()).toHaveAttribute('aria-valuenow', String(SIDEBAR_DEFAULT_PX - KEY_STEP_PX));
    fireEvent.keyDown(handle(), { key: 'End' });
    expect(handle()).toHaveAttribute('aria-valuenow', String(SIDEBAR_MAX_PX));
    fireEvent.keyDown(handle(), { key: 'Home' });
    expect(handle()).toHaveAttribute('aria-valuenow', String(SIDEBAR_MIN_PX));
  });

  it('a double-click resets the default width', () => {
    const s = memoryStorage({ [SIDEBAR_WIDTH_KEY]: '600' });
    render(<Harness storage={() => s} />);
    fireEvent.doubleClick(handle());
    expect(handle()).toHaveAttribute('aria-valuenow', String(SIDEBAR_DEFAULT_PX));
    expect(s.data[SIDEBAR_WIDTH_KEY]).toBe(String(SIDEBAR_DEFAULT_PX));
  });

  it('still resizes when storage is blocked', () => {
    render(<Harness storage={throwing} />);
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    expect(handle()).toHaveAttribute('aria-valuenow', String(SIDEBAR_DEFAULT_PX + KEY_STEP_PX));
  });
});

describe('useSidebarWidth on window resize', () => {
  it('shrinks to fit a smaller window, and returns to the stored width when it grows', () => {
    const s = memoryStorage({ [SIDEBAR_WIDTH_KEY]: '600' });
    const storage = () => s;
    const { result } = renderHook(() => useSidebarWidth(storage));
    expect(result.current[0]).toBe(600);
    act(() => {
      setViewport(800);
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current[0]).toBe(800 - MIN_CHART_PX);
    act(() => {
      setViewport(1440);
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current[0]).toBe(600);
  });
});
