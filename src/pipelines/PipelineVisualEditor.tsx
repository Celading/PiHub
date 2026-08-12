import { useState } from 'react';
import type { Pipeline, PipelineStep } from '../../shared/types.js';
import { useI18n, type MessageKey } from '../i18n/I18nProvider.js';

/**
 * UX workbench (audit): the visual pipeline editor — a horizontal execution
 * band (`输入 → 分析 → 审批 → …`) where steps are inserted as
 * prompt / steer / approval / setModel / setThinking chips, and a right-side
 * Inspector edits the selected step's variables and the run's failure
 * policy. JSON remains as the "source mode" behind a view toggle.
 */

const STEP_TYPES: ReadonlyArray<PipelineStep['type']> = [
  'prompt',
  'steer',
  'approval',
  'setModel',
  'setThinking',
];

const STEP_TYPE_KEYS: Record<PipelineStep['type'], MessageKey> = {
  prompt: 'pipelines.step.prompt',
  steer: 'pipelines.step.steer',
  approval: 'pipelines.step.approval',
  setModel: 'pipelines.step.setModel',
  setThinking: 'pipelines.step.setThinking',
};

const STEP_TYPE_GLYPHS: Record<PipelineStep['type'], string> = {
  prompt: 'P',
  steer: 'S',
  approval: '✓',
  setModel: 'M',
  setThinking: 'T',
};

function nextStepId(steps: PipelineStep[]): string {
  let index = steps.length + 1;
  while (steps.some((step) => step.id === `s${String(index)}`)) {
    index += 1;
  }
  return `s${String(index)}`;
}

export function PipelineVisualEditor({
  initial,
  onSave,
  onCancel,
  saving,
}: {
  initial: Pipeline;
  onSave: (pipeline: Pipeline) => void;
  onCancel: () => void;
  saving: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? '');
  const [onError, setOnError] = useState<Pipeline['onError']>(initial.onError);
  const [steps, setSteps] = useState<PipelineStep[]>(initial.steps);
  const [selectedId, setSelectedId] = useState<string | null>(initial.steps[0]?.id ?? null);
  const [view, setView] = useState<'visual' | 'source'>('visual');
  const [sourceText, setSourceText] = useState<string>(() => JSON.stringify(initial, null, 2));
  const [error, setError] = useState<string | null>(null);

  const selected = steps.find((step) => step.id === selectedId) ?? null;

  const patchSelected = (patch: Partial<PipelineStep>): void => {
    if (selectedId === null) {
      return;
    }
    setSteps((prev) =>
      prev.map((step) => (step.id === selectedId ? { ...step, ...patch } : step)),
    );
  };

  const insertStep = (type: PipelineStep['type']): void => {
    const step: PipelineStep = { id: nextStepId(steps), name: t(STEP_TYPE_KEYS[type]), type };
    setSteps((prev) => [...prev, step]);
    setSelectedId(step.id);
  };

  const removeStep = (id: string): void => {
    setSteps((prev) => {
      const next = prev.filter((step) => step.id !== id);
      if (selectedId === id) {
        setSelectedId(next[0]?.id ?? null);
      }
      return next;
    });
  };

  const save = (): void => {
    setError(null);
    if (view === 'source') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(sourceText) as unknown;
      } catch (err) {
        setError(t('pipelines.editor.invalid', { error: err instanceof Error ? err.message : String(err) }));
        return;
      }
      const candidate = parsed as Record<string, unknown>;
      const now = new Date().toISOString();
      const pipeline: Pipeline = {
        id:
          typeof candidate['id'] === 'string' && candidate['id'].length > 0
            ? candidate['id']
            : initial.id,
        name:
          typeof candidate['name'] === 'string' && candidate['name'].length > 0
            ? candidate['name']
            : 'Untitled',
        steps: Array.isArray(candidate['steps']) ? (candidate['steps'] as PipelineStep[]) : [],
        onError:
          candidate['onError'] === 'skip' || candidate['onError'] === 'retry'
            ? candidate['onError']
            : 'stop',
        createdAt: typeof candidate['createdAt'] === 'string' ? candidate['createdAt'] : initial.createdAt,
        updatedAt: now,
        ...(typeof candidate['description'] === 'string' ? { description: candidate['description'] } : {}),
      };
      onSave(pipeline);
      return;
    }
    onSave({
      id: initial.id,
      name: name.trim().length > 0 ? name.trim() : 'Untitled',
      ...(description.trim().length > 0 ? { description: description.trim() } : {}),
      steps,
      onError,
      createdAt: initial.createdAt,
      updatedAt: new Date().toISOString(),
    });
  };

  return (
    <div className="pipe-visual-editor">
      <div className="pipe-editor-head">
        <input
          className="pipe-visual-name mono"
          value={name}
          aria-label={t('pipelines.editor.name')}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <select
          className="pipe-visual-onerror mono"
          value={onError}
          aria-label={t('pipelines.inspector.onError')}
          onChange={(event) => {
            setOnError(event.target.value as Pipeline['onError']);
          }}
        >
          <option value="stop">{t('pipelines.onError.stop')}</option>
          <option value="skip">{t('pipelines.onError.skip')}</option>
          <option value="retry">{t('pipelines.onError.retry')}</option>
        </select>
        <span className="pipe-visual-view-toggle mono" role="group" aria-label={t('pipelines.editor.view')}>
          <button
            type="button"
            className="pipe-visual-view-btn"
            data-active={view === 'visual'}
            onClick={() => {
              setView('visual');
            }}
          >
            {t('pipelines.editor.visual')}
          </button>
          <button
            type="button"
            className="pipe-visual-view-btn"
            data-active={view === 'source'}
            onClick={() => {
              setSourceText(
                JSON.stringify(
                  {
                    id: initial.id,
                    name,
                    ...(description.trim().length > 0 ? { description: description.trim() } : {}),
                    steps,
                    onError,
                  },
                  null,
                  2,
                ),
              );
              setView('source');
            }}
          >
            {t('pipelines.editor.source')}
          </button>
        </span>
        <button
          type="button"
          className="btn-secondary mono"
          onClick={onCancel}
        >
          {t('pipelines.editor.cancel')}
        </button>
        <button
          type="button"
          className="btn-primary mono"
          disabled={saving || steps.length === 0}
          onClick={save}
        >
          {saving ? t('settings.loading') : t('pipelines.editor.save')}
        </button>
      </div>
      <input
        className="pipe-visual-desc mono"
        value={description}
        placeholder={t('pipelines.inspector.description')}
        aria-label={t('pipelines.inspector.description')}
        onChange={(event) => {
          setDescription(event.target.value);
        }}
      />

      {error !== null ? (
        <div className="automation-error mono" role="alert">
          {error}
        </div>
      ) : null}

      {view === 'source' ? (
        <textarea
          className="pipe-editor-text mono"
          spellCheck={false}
          value={sourceText}
          onChange={(event) => {
            setSourceText(event.target.value);
          }}
        />
      ) : (
        <div className="pipe-visual-body">
          {/* Execution band: the audit's 执行带 — steps left to right with
              type glyphs; the trailing + inserts a new step type. */}
          <div className="pipe-band" data-shot="pipeline-band">
            {steps.map((step, index) => (
              <div
                key={step.id}
                className="pipe-band-step"
                data-type={step.type}
                data-selected={selectedId === step.id}
              >
                <button
                  type="button"
                  className="pipe-band-chip mono"
                  onClick={() => {
                    setSelectedId(step.id);
                  }}
                >
                  <span className="pipe-band-index" aria-hidden="true">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span className="pipe-band-glyph" aria-hidden="true">
                    {STEP_TYPE_GLYPHS[step.type]}
                  </span>
                  <span className="pipe-band-name">{step.name}</span>
                </button>
                <button
                  type="button"
                  className="pipe-band-remove mono"
                  title={t('pipelines.step.remove')}
                  aria-label={`${t('pipelines.step.remove')} ${step.name}`}
                  onClick={() => {
                    removeStep(step.id);
                  }}
                >
                  ×
                </button>
                {index < steps.length - 1 ? (
                  <span className="pipe-band-arrow" aria-hidden="true">
                    →
                  </span>
                ) : null}
              </div>
            ))}
            <div className="pipe-band-add">
              {STEP_TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  className="pipe-band-add-btn mono"
                  data-type={type}
                  title={t(STEP_TYPE_KEYS[type])}
                  onClick={() => {
                    insertStep(type);
                  }}
                >
                  +{STEP_TYPE_GLYPHS[type]}
                </button>
              ))}
            </div>
          </div>

          {/* Inspector: the selected step's variables + failure policy. */}
          <div className="pipe-inspector" data-shot="pipeline-inspector">
            {selected === null ? (
              <p className="automation-hint">{t('pipelines.inspector.empty')}</p>
            ) : (
              <>
                <div className="pipe-inspector-row">
                  <span className="pipe-inspector-label mono">{t('pipelines.inspector.name')}</span>
                  <input
                    className="pipe-inspector-input mono"
                    value={selected.name}
                    onChange={(event) => {
                      patchSelected({ name: event.target.value });
                    }}
                  />
                </div>
                <div className="pipe-inspector-row">
                  <span className="pipe-inspector-label mono">{t('pipelines.inspector.type')}</span>
                  <span className="pipe-inspector-value mono" data-type={selected.type}>
                    {t(STEP_TYPE_KEYS[selected.type])}
                  </span>
                </div>
                {selected.type === 'prompt' || selected.type === 'steer' ? (
                  <div className="pipe-inspector-row pipe-inspector-stack">
                    <span className="pipe-inspector-label mono">{t('pipelines.inspector.prompt')}</span>
                    <textarea
                      className="pipe-inspector-text mono"
                      value={selected.prompt ?? ''}
                      spellCheck={false}
                      onChange={(event) => {
                        patchSelected({ prompt: event.target.value });
                      }}
                    />
                  </div>
                ) : null}
                {(selected.type === 'prompt' || selected.type === 'steer') &&
                selected.streamingBehavior !== undefined ? (
                  <div className="pipe-inspector-row">
                    <span className="pipe-inspector-label mono">
                      {t('pipelines.inspector.streamingBehavior')}
                    </span>
                    <select
                      className="pipe-inspector-input mono"
                      value={selected.streamingBehavior}
                      onChange={(event) => {
                        patchSelected({
                          streamingBehavior: event.target.value as PipelineStep['streamingBehavior'],
                        });
                      }}
                    >
                      <option value="normal">normal</option>
                      <option value="steer">steer</option>
                      <option value="followUp">followUp</option>
                    </select>
                  </div>
                ) : null}
                {selected.type === 'setModel' ? (
                  <>
                    <div className="pipe-inspector-row">
                      <span className="pipe-inspector-label mono">
                        {t('pipelines.inspector.provider')}
                      </span>
                      <input
                        className="pipe-inspector-input mono"
                        value={selected.model?.provider ?? ''}
                        onChange={(event) => {
                          patchSelected({
                            model: {
                              provider: event.target.value,
                              id: selected.model?.id ?? '',
                            },
                          });
                        }}
                      />
                    </div>
                    <div className="pipe-inspector-row">
                      <span className="pipe-inspector-label mono">{t('pipelines.inspector.model')}</span>
                      <input
                        className="pipe-inspector-input mono"
                        value={selected.model?.id ?? ''}
                        onChange={(event) => {
                          patchSelected({
                            model: {
                              provider: selected.model?.provider ?? '',
                              id: event.target.value,
                            },
                          });
                        }}
                      />
                    </div>
                  </>
                ) : null}
                {selected.type === 'setThinking' ? (
                  <div className="pipe-inspector-row">
                    <span className="pipe-inspector-label mono">
                      {t('pipelines.inspector.thinkingLevel')}
                    </span>
                    <input
                      className="pipe-inspector-input mono"
                      value={selected.thinkingLevel ?? ''}
                      onChange={(event) => {
                        patchSelected({ thinkingLevel: event.target.value });
                      }}
                    />
                  </div>
                ) : null}
                {selected.type === 'approval' ? (
                  <div className="pipe-inspector-row">
                    <span className="pipe-inspector-label mono">{t('pipelines.inspector.match')}</span>
                    <input
                      className="pipe-inspector-input mono"
                      value={selected.match ?? ''}
                      placeholder={t('pipelines.inspector.matchHint')}
                      onChange={(event) => {
                        patchSelected({ match: event.target.value });
                      }}
                    />
                  </div>
                ) : null}
                <div className="pipe-inspector-row">
                  <span className="pipe-inspector-label mono">{t('pipelines.inspector.maxRetries')}</span>
                  <input
                    className="pipe-inspector-input mono"
                    type="number"
                    min={0}
                    value={String(selected.maxRetries ?? 0)}
                    onChange={(event) => {
                      const parsed = Number.parseInt(event.target.value, 10);
                      patchSelected({
                        maxRetries: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0,
                      });
                    }}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
