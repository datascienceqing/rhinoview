/**
 * The ONE place the pane UI chooses its indicator math. Swapping implementations is a
 * change to this line only; nothing else in `src/panes/` knows which one it has.
 */
export { computeIndicator } from '../indicators';
