import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider.js';
import { api } from '../api/client.js';

interface HealthInfo {
  status: string;
  name: string;
  version: string;
  build?: string;
  time: string;
  home?: string;
  configFile?: string | null;
  url?: string;
}

/** Settings → About: published version, install/run instructions, docs and
 *  the security boundary — the "getting started" surface inside the panel. */
export function AboutSection(): React.JSX.Element {
  const { t } = useI18n();
  const [info, setInfo] = useState<HealthInfo | null>(null);
  // The actual serving port (a custom PIHUB_PORT/PORT shows up here too).
  const port = typeof window !== 'undefined' && window.location.port.length > 0 ? window.location.port : '18384';

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
        <code className="about-code mono">
          v{info?.version ?? '—'}
          {info?.build !== undefined && info.build.length > 0 ? ` · ${info.build}` : ''}
        </code>
      </div>

      <div className="about-block">
        <div className="about-label mono">{t('about.install')}</div>
        <pre className="about-code mono">npm install -g @celading/pihub</pre>
        <pre className="about-code mono">pihub</pre>
        <p className="settings-hint">{t('about.installHint', { port })}</p>
        <p className="settings-hint">{t('about.pwaHint')}</p>
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
        {info?.home !== undefined ? (
          <p className="settings-hint mono">
            {t('about.home')}: {info.home}
          </p>
        ) : null}
        {info?.configFile !== undefined && info.configFile !== null ? (
          <p className="settings-hint mono">
            {t('about.configFile')}: {info.configFile}
          </p>
        ) : null}
      </div>
    </section>
  );
}
