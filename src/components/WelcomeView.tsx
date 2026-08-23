import { useMemo, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider.js';
import { loadFavorites } from '../favorites/favoritesStore.js';
import './WelcomeView.css';

const DEFAULT_SUGGESTIONS: Array<{ label: string; prompt: string }> = [
  { label: '审计这个项目', prompt: '审计这个项目：结构、风险、可改进点，输出一份诚实的审查报告。' },
  { label: '评价下这个项目', prompt: '评价下这个项目：架构、代码质量、扩展性，给出打分与理由。' },
  { label: '继续工作未完成项', prompt: '在这个项目继续工作未完成项：先盘点 TODO/未完成工作，再继续推进。' },
  { label: '解释代码库结构', prompt: '解释这个代码库的结构：模块划分、入口、数据流。' },
  { label: '找 Bug', prompt: '找这个项目的潜在 Bug：边界条件、并发、资源释放。' },
  { label: '补测试', prompt: '为这个项目补测试：找关键路径，写可运行的测试。' },
  { label: '写 README', prompt: '为这个项目写一份 README：安装、使用、架构。' },
];

function pickSuggestions(count = 3): Array<{ label: string; prompt: string }> {
  // Reuse the panel's favorites store (settings → favorites): plain prompt
  // texts, labeled with their head.
  const favorites = loadFavorites().map((prompt) => ({
    label: prompt.length > 12 ? `${prompt.slice(0, 12)}…` : prompt,
    prompt,
  }));
  const pool = [...favorites, ...DEFAULT_SUGGESTIONS];
  // De-duplicate by label, shuffle, take count.
  const seen = new Set<string>();
  const unique = pool.filter((entry) => {
    if (seen.has(entry.label)) {
      return false;
    }
    seen.add(entry.label);
    return true;
  });
  const shuffled: Array<{ label: string; prompt: string }> = [];
  for (let i = unique.length - 1; i >= 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const picked = unique[j];
    if (picked !== undefined) {
      shuffled.push(picked);
      unique.splice(j, 1);
    }
  }
  return shuffled.slice(0, count);
  return unique.slice(0, count);
}

interface WelcomeViewProps {
  /** Current workspace label (folder name) to greet with. */
  workspaceLabel: string;
  onSend: (text: string) => void;
  /** Open the favorites settings (SettingsPage prompt-favorites section). */
  onOpenFavorites: () => void;
}

/**
 * Empty-chat welcome view: PiHub + 📂 workspace + a centered input that
 * floats up from the bottom composer area; suggestion chips (random from the
 * default pool + the user's prompt favorites).
 */
export function WelcomeView({ workspaceLabel, onSend, onOpenFavorites }: WelcomeViewProps): React.JSX.Element {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const suggestions = useMemo(() => pickSuggestions(3), []);

  const submit = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      onSend(trimmed);
    }
  };

  return (
    <div className="welcome-view">
      <div className="welcome-brand mono">{t('brand.name')}</div>
      <div className="welcome-headline">
        {t('welcome.ready', { folder: workspaceLabel })}
      </div>

      <div className="welcome-input-wrap">
        <input
          type="text"
          className="welcome-input mono"
          placeholder={t('welcome.inputPlaceholder')}
          value={draft}
          autoFocus
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              submit(draft);
              setDraft('');
            }
          }}
        />
      </div>

      <div className="welcome-suggestions">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion.label}
            type="button"
            className="welcome-suggestion mono"
            onClick={() => {
              submit(suggestion.prompt);
            }}
          >
            {suggestion.label}
          </button>
        ))}
        <button type="button" className="welcome-suggestion welcome-suggestion-gear mono" onClick={onOpenFavorites} title={t('welcome.favoritesHint')}>
          {t('welcome.favorites')}
        </button>
      </div>
    </div>
  );
}
