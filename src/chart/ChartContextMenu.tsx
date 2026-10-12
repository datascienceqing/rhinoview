/**
 * The chart menu (docs/ALERTS_PLAN.md, section 4.1). It opens at the pointer on a right-click
 * on the chart, or at the middle of the chart with the menu key or Shift+F10.
 *
 * Items: add an alert, switch the theme, switch the language, open Financials. Esc, a click
 * outside, a real scroll (not the small wheel noise of a touch mouse), or a window resize closes it. Near an edge it opens to the other side.
 */
import { useLayoutEffect, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { useTheme } from '../theme';

export interface ChartMenuItem {
  id: string;
  label: string;
  onSelect(): void;
}

export interface ChartContextMenuProps {
  x: number;
  y: number;
  /** The add-alert items (the price, then indicators); empty when nothing at the point can have an alert. */
  alertItems: readonly ChartMenuItem[];
  /** Opens Financials; omitted when the server serves no fundamentals. */
  onFinancials?: () => void;
  onClose(): void;
}

const EDGE = 4;
/**
 * A touch-surface mouse (Apple Magic Mouse) sends small wheel events when a finger rests on
 * it during a right-click. So a scroll closes the menu only after this grace time, and only
 * when it moved at least SCROLL_CLOSE_PX.
 */
export const SCROLL_GRACE_MS = 400;
export const SCROLL_CLOSE_PX = 24;

/** The wheel distance in pixels, for any delta mode (pixels, lines, pages). */
function wheelPixels(e: WheelEvent): number {
  const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
  return (Math.abs(e.deltaX) + Math.abs(e.deltaY)) * scale;
}

export function ChartContextMenu({ x, y, alertItems, onFinancials, onClose }: ChartContextMenuProps) {
  const { t, toggleLocale } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  const items: ChartMenuItem[] = [
    ...alertItems,
    { id: 'theme', label: theme === 'dark' ? t('menu.theme.light') : t('menu.theme.dark'), onSelect: toggleTheme },
    { id: 'language', label: t('menu.language', { target: t('locale.toggle') }), onSelect: toggleLocale },
    ...(onFinancials ? [{ id: 'financials', label: t('toolbar.financials'), onSelect: onFinancials }] : []),
  ];

  // Open to the other side of the pointer when the menu would cross the window edge.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = x + width + EDGE > window.innerWidth ? Math.max(EDGE, x - width) : x;
    const top = y + height + EDGE > window.innerHeight ? Math.max(EDGE, y - height) : y;
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const close = () => onClose();
    const openedAt = performance.now();
    let scrolled = 0;
    const onWheel = (e: WheelEvent) => {
      if (performance.now() - openedAt < SCROLL_GRACE_MS) return;
      scrolled += wheelPixels(e);
      if (scrolled >= SCROLL_CLOSE_PX) onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [onClose]);

  function onKeyDown(e: React.KeyboardEvent) {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = (i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (e.key === 'Tab') {
      onClose();
    }
  }

  return (
    <div
      ref={ref}
      className="chart-menu"
      role="menu"
      aria-label={t('menu.label')}
      style={{ left: pos.left, top: pos.top }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className="chart-menu-item"
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
