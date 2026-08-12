import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider.js';
import { api } from '../api/client.js';

interface HealthInfo {
  status: string;
  name: string;
  version: string;
  time: string;
}

/** Settings → About: published version, install/run instructions, docs and
 *  the security boundary — the "getting started" surface inside the panel. */
export function AboutSection(): React.JSX.Element {
  const { t } = useI18n();
  const [info, setInfo] = useState<HealthInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .health()
      .then((health) => {
        if (!cancelled) {
          setInfo(health);
        }
      })
      .catch(() => {
        // backend offline; version stays unknown
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="settings-section">
      <h2 className="settings-section-title mono">π {t('brand.name')}</h2>
      <p className="settings-hint">{t('about.tagline')}</p>

      <div className="about-block">
        <div className="about-label mono">{t('about.version')}</div>
        <code className="about-code mono">v{info?.version ?? '—'}</code>
      </div>

      <div className="about-block">
        <div className="about-label mono">{t('about.install')}</div>
        <pre className="about-code mono">npm install -g @celading/pihub</pre>
        <pre className="about-code mono">pihub</pre>
        <p className="settings-hint">{t('about.installHint')}</p>
      </div>

      <div className="about-block">
        <div className="about-label mono">{t('about.docs')}</div>
        <div className="about-links">
          <a href="https://github.com/HapPub/PiHub" target="_blank" rel="noreferrer">
            {t('about.source')}
          </a>
          <span aria-hidden="true">·</span>
          <a
            href="https://github.com/HapPub/PiHub/blob/main/MANUAL.md"
            target="_blank"
            rel="noreferrer"
          >
            {t('about.manual')}
          </a>
        </div>
      </div>

      <div className="about-block">
        <div className="about-label mono">{t('about.security')}</div>
        <p className="settings-hint">{t('about.securityHint')}</p>
      </div>
    </section>
  );
}
