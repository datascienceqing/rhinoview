import { LOGO_HEAD, LOGO_HORN, LOGO_VIEWBOX } from './logo';

/** The mark and the name, at the left of the toolbar. The mark uses the accent colour. */
export function Logo() {
  return (
    <span className="app-logo">
      <svg viewBox={LOGO_VIEWBOX} width="22" height="22" aria-hidden="true" focusable="false">
        <path fill="currentColor" d={LOGO_HORN} />
        <path fill="currentColor" fillRule="evenodd" d={LOGO_HEAD} />
      </svg>
      <span className="app-logo-name">RhinoView</span>
    </span>
  );
}
