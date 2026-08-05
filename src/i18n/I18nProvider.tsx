/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import {
  enMessages,
  isLocale,
  LOCALE_STORAGE_KEY,
  zhMessages,
  type Locale,
  type MessageKey,
} from './messages.js';

export type { Locale, MessageKey };

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
  /** Interpolates `{name}` placeholders inside a message. */
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
  /** BCP-47 tag for Intl formatting (dates, numbers). */
  intlTag: string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

const MESSAGES: Record<Locale, Record<MessageKey, string>> = {
  zh: zhMessages,
  en: enMessages,
};

const INTL_TAGS: Record<Locale, string> = {
  zh: 'zh-CN',
  en: 'en-US',
};

function interpolate(template: string, params: Record<string, string | number> | undefined): string {
  if (params === undefined) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

export function I18nProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
    return saved !== null && isLocale(saved) ? saved : 'zh';
  });

  const setLocale = useCallback((next: Locale): void => {
    setLocaleState(next);
    localStorage.setItem(LOCALE_STORAGE_KEY, next);
  }, []);

  const toggleLocale = useCallback((): void => {
    setLocaleState((current) => {
      const next: Locale = current === 'zh' ? 'en' : 'zh';
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
      return next;
    });
  }, []);

  const value = useMemo<I18nContextValue>(() => {
    const t = (key: MessageKey, params?: Record<string, string | number>): string =>
      interpolate(MESSAGES[locale][key], params);
    return {
      locale,
      setLocale,
      toggleLocale,
      t,
      intlTag: INTL_TAGS[locale],
    };
  }, [locale, setLocale, toggleLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (context === null) {
    throw new Error('useI18n must be used within I18nProvider');
  }
  return context;
}
