import { useCallback, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider.js';

type NotifyState = 'granted' | 'denied' | 'default' | 'unsupported';

function readNotifyState(): NotifyState {
  if (!('Notification' in window)) {
    return 'unsupported';
  }
  return Notification.permission;
}

export function PermissionsSection(): React.JSX.Element {
  const { t } = useI18n();
  const [notifyState, setNotifyState] = useState<NotifyState>(() => readNotifyState());

  const requestNotify = useCallback((): void => {
    if (!('Notification' in window)) {
      setNotifyState('unsupported');
      return;
    }
    void Notification.requestPermission().then((permission) => {
      setNotifyState(permission);
    });
  }, []);

  const notifyLabel =
    notifyState === 'granted'
      ? t('permissions.notify.granted')
      : notifyState === 'denied'
        ? t('permissions.notify.denied')
        : notifyState === 'unsupported'
          ? t('permissions.notify.unsupported')
          : t('permissions.notify.default');

  return (
    <section className="settings-section">
      <h2 className="settings-section-title mono">{t('settings.nav.permissions')}</h2>

      <h3 className="settings-subtitle mono">{t('permissions.notify')}</h3>
      <div className="setting-row">
        <span className="setting-label mono">{t('permissions.notify.state')}</span>
        <div className="setting-row-value">
          <span className="setting-value mono" data-state={notifyState}>
            {notifyLabel}
          </span>
          {notifyState === 'default' ? (
            <button type="button" className="setting-restore" onClick={requestNotify}>
              {t('permissions.notify.request')}
            </button>
          ) : null}
        </div>
      </div>
      <p className="settings-hint">{t('permissions.notifyHint')}</p>

      <h3 className="settings-subtitle mono">{t('permissions.localTitle')}</h3>
      <div className="permissions-boundary mono">
        <p>{t('permissions.localHint1')}</p>
        <p>{t('permissions.localHint2')}</p>
      </div>
    </section>
  );
}
