/**
 * Named-layout switcher in the toolbar. PHASE 5 SLOT — Worker W4 implements.
 * Wave 0 shows only the active layout's name.
 */
import { useActiveChart } from '../workspace';

export function LayoutSwitcher() {
  const { chart } = useActiveChart();
  return (
    <div className="layout-switcher" data-testid="layout-switcher">
      {chart.name}
    </div>
  );
}
