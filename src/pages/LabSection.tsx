import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider.js';
import {
  getLabFlag,
  LAB_CHANGED_EVENT,
  setLabFlag,
  type LabFlag,
} from '../lab/labFlags.js';

const LAB_SWITCHES: ReadonlyArray<{
  flag: LabFlag;
  labelKey:
    | 'lab.streamAnimation'
    | 'lab.compactTools'
    | 'lab.settledNotify'
    | 'lab.simplifiedOutput'
    | 'lab.showThinkingLive'
    | 'lab.typewriter'
    | 'lab.settledCollapse';
  hintKey:
    | 'lab.streamAnimationHint'
    | 'lab.compactToolsHint'
    | 'lab.settledNotifyHint'
    | 'lab.simplifiedOutputHint'
    | 'lab.showThinkingLiveHint'
    | 'lab.typewriterHint'
    | 'lab.settledCollapseHint';
}> = [
  {
    flag: 'streamAnimation',
    labelKey: 'lab.streamAnimation',
    hintKey: 'lab.streamAnimationHint',
  },
  {
    flag: 'typewriter',
    labelKey: 'lab.typewriter',
    hintKey: 'lab.typewriterHint',
  },
  {
    flag: 'settledCollapse',
    labelKey: 'lab.settledCollapse',
    hintKey: 'lab.settledCollapseHint',
  },
  {
    flag: 'compactTools',
    labelKey: 'lab.compactTools',
    hintKey: 'lab.compactToolsHint',
  },
  {
    flag: 'settledNotify',
    labelKey: 'lab.settledNotify',
    hintKey: 'lab.settledNotifyHint',
  },
  {
    flag: 'simplifiedOutput',
    labelKey: 'lab.simplifiedOutput',
    hintKey: 'lab.simplifiedOutputHint',
  },
  {
    flag: 'showThinkingLive',
    labelKey: 'lab.showThinkingLive',
    hintKey: 'lab.showThinkingLiveHint',
  },
];

export function LabSection(): React.JSX.Element {
  const { t } = useI18n();
  // Re-render (via setState) whenever any lab switch changes so the
  // controlled checkboxes stay in sync.
  const [, forceRender] = useState(0);

  useEffect(() => {
    const sync = (): void => {
      forceRender((prev) => prev + 1);
    };
    window.addEventListener(LAB_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener(LAB_CHANGED_EVENT, sync);
    };
  }, []);

  return (
    <section className="settings-section">
      <h2 className="settings-section-title mono">{t('settings.nav.lab')}</h2>
      <p className="settings-hint">{t('lab.hint')}</p>
      <div className="settings-list">
        {LAB_SWITCHES.map((entry) => (
          <div key={entry.flag} className="lab-row">
            <div className="lab-row-text">
              <span className="lab-row-label">{t(entry.labelKey)}</span>
              <span className="lab-row-hint mono">{t(entry.hintKey)}</span>
            </div>
            <label className="lab-switch">
              <input
                type="checkbox"
                checked={getLabFlag(entry.flag)}
                onChange={(event) => {
                  setLabFlag(entry.flag, event.target.checked);
                }}
              />
              <span className="lab-switch-track" aria-hidden="true" />
            </label>
          </div>
        ))}
      </div>
    </section>
  );
}
