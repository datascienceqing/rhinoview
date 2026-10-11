/**
 * The chart menu (docs/ALERTS_PLAN.md, section 4.1). It opens at the pointer on a right-click
 * on the chart, or at the middle of the chart with the menu key or Shift+F10.
 *
 * Items: add an alert, switch the theme, switch the language, open Financials. Esc, a click
 * outside, a scroll, or a window resize closes it. Near an edge it opens to the other side.
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
  /** The add-alert item, or null when nothing at the point can have an alert. */
  addAlert: ChartMenuItem | null;
  /** Opens Financials; omitted when the server serves no fundamentals. */
  onFinancials?: () => void;
  onClose(): void;
}

const EDGE = 4;

export function ChartContextMenu({ x, y, addAlert, onFinancials, onClose }: ChartContextMenuProps) {
  const { t, toggleLocale } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  const items: ChartMenuItem[] = [
    ...(addAlert ? [addAlert] : []),
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
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('wheel', close, { passive: true });
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('wheel', close);
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
