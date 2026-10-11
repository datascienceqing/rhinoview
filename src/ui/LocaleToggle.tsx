import { useI18n } from '../i18n';

/** Shows the language it switches to: "中文" in English, "EN" in Chinese. */
export function LocaleToggle() {
  const { t, toggleLocale } = useI18n();
  const label = t('locale.toggleLabel');
  return (
    <button type="button" className="toolbar-toggle locale-toggle" aria-label={label} title={label} onClick={toggleLocale}>
      {t('locale.toggle')}
    </button>
  );
}
