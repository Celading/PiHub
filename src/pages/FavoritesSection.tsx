import { useState } from 'react';
import { useI18n } from '../i18n/I18nProvider.js';
import { loadFavorites, persistFavorites } from '../favorites/favoritesStore.js';

interface FavoritesSectionProps {
  onRun: (text: string) => void;
}

export function FavoritesSection({ onRun }: FavoritesSectionProps): React.JSX.Element {
  const { t } = useI18n();
  const [favorites, setFavorites] = useState<string[]>(() => loadFavorites());
  const [draft, setDraft] = useState('');

  const refresh = (): void => {
    setFavorites(loadFavorites());
  };

  const addDraft = (): void => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      return;
    }
    setFavorites((prev) => [...prev.filter((item) => item !== trimmed), trimmed]);
    persistFavorites([...favorites.filter((item) => item !== trimmed), trimmed]);
    setDraft('');
  };

  const remove = (text: string): void => {
    const next = favorites.filter((item) => item !== text);
    setFavorites(next);
    persistFavorites(next);
  };

  return (
    <section className="settings-section">
      <h2 className="settings-section-title mono">{t('settings.nav.favorites')}</h2>
      <p className="settings-hint">{t('favorites.hint')}</p>
      <div className="favorites-add-row">
        <input
          className="channel-input mono"
          value={draft}
          placeholder={t('favorites.placeholder')}
          aria-label={t('favorites.placeholder')}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              addDraft();
            }
          }}
        />
        <button type="button" className="btn-primary" onClick={addDraft}>
          {t('favorites.add')}
        </button>
      </div>
      {favorites.length === 0 ? (
        <p className="settings-hint">{t('favorites.empty')}</p>
      ) : (
        <div className="settings-list">
          {favorites.map((text) => (
            <div key={text} className="setting-row">
              <span className="setting-label">{text}</span>
              <span className="setting-value" />
              <div className="favorites-actions">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => {
                    onRun(text);
                  }}
                >
                  {t('favorites.run')}
                </button>
                <button
                  type="button"
                  className="favorites-remove"
                  onClick={() => {
                    remove(text);
                  }}
                >
                  {t('favorites.delete')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <button type="button" className="favorites-refresh" onClick={refresh}>
        {t('favorites.refresh')}
      </button>
    </section>
  );
}
