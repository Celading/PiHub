import { useMemo, useState } from 'react';
import type { Pipeline } from '../../shared/types.js';
import { usePipelines } from './usePipelines.js';
import { useI18n, type MessageKey } from '../i18n/I18nProvider.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { LoadingHint } from '../components/LoadingHint.js';
import './PipelinesTab.css';

const RUN_STATUS_KEYS: Record<string, MessageKey> = {
  idle: 'pipelines.status.idle',
  running: 'pipelines.status.running',
  completed: 'pipelines.status.completed',
  aborted: 'pipelines.status.aborted',
  failed: 'pipelines.status.failed',
};

/** Starter JSON for the pipeline editor (kept flat and self-documenting). */
function editorTemplate(): string {
  return JSON.stringify(
    {
      id: 'pipeline-1',
      name: '我的工程流',
      description: '',
      onError: 'stop',
      steps: [
        { id: 's1', name: '分析', type: 'prompt', prompt: '分析 {{input}}，输出计划' },
        { id: 's2', name: '确认', type: 'approval' },
        { id: 's3', name: '执行', type: 'prompt', prompt: '执行计划：{{lastOutput}}' },
      ],
    },
    null,
    2,
  );
}

/**
 * Pipelines tab (P1-02-C4): definition list with run status lights, JSON
 * editor modal for create/edit, guarded delete. The live run timeline view
 * lands in C5.
 */
export function PipelinesTab(): React.JSX.Element {
  const { t } = useI18n();
  const { pipelines, runs, error, save, remove, run } = usePipelines();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorText, setEditorText] = useState<string>(() => editorTemplate());
  const [editorError, setEditorError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Pipeline | null>(null);

  const latestRuns = useMemo(() => {
    const map = new Map<string, Pipeline['id']>();
    const byPipeline = new Map<string, (typeof runs)[number]>();
    for (const record of runs) {
      const existing = byPipeline.get(record.pipelineId);
      if (existing === undefined || record.startedAt > existing.startedAt) {
        byPipeline.set(record.pipelineId, record);
      }
    }
    void map;
    return byPipeline;
  }, [runs]);

  const openEditor = (pipeline: Pipeline | null): void => {
    setEditorText(JSON.stringify(pipeline ?? (JSON.parse(editorTemplate()) as unknown), null, 2));
    setEditorError(null);
    setEditorOpen(true);
  };

  const submitEditor = async (): Promise<void> => {
    setEditorError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(editorText) as unknown;
    } catch (err) {
      setEditorError(t('pipelines.editor.invalid', { error: err instanceof Error ? err.message : String(err) }));
      return;
    }
    const candidate = parsed as Record<string, unknown>;
    const now = new Date().toISOString();
    const pipeline: Pipeline = {
      id: typeof candidate['id'] === 'string' && candidate['id'].length > 0 ? candidate['id'] : `pipeline-${String(Date.now())}`,
      name: typeof candidate['name'] === 'string' && candidate['name'].length > 0 ? candidate['name'] : 'Untitled',
      steps: Array.isArray(candidate['steps']) ? (candidate['steps'] as Pipeline['steps']) : [],
      onError: candidate['onError'] === 'skip' || candidate['onError'] === 'retry' ? candidate['onError'] : 'stop',
      createdAt: typeof candidate['createdAt'] === 'string' ? candidate['createdAt'] : now,
      updatedAt: now,
      ...(typeof candidate['description'] === 'string' ? { description: candidate['description'] } : {}),
    };
    setSaving(true);
    try {
      await save(pipeline);
      setEditorOpen(false);
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pipelines-tab">
      <div className="pipelines-toolbar">
        <span className="pipelines-note mono">{t('pipelines.note')}</span>
        <button
          type="button"
          className="btn-primary pipelines-new"
          onClick={() => {
            openEditor(null);
          }}
        >
          + {t('pipelines.new')}
        </button>
      </div>

      {error !== null ? (
        <div className="automation-error mono" role="alert">
          {error}
        </div>
      ) : null}

      {pipelines === null ? (
        <p className="automation-hint">
          <LoadingHint>{t('settings.loading')}</LoadingHint>
        </p>
      ) : pipelines.length === 0 ? (
        <p className="automation-hint">{t('pipelines.empty')}</p>
      ) : (
        <div className="pipelines-list">
          {pipelines.map((pipeline) => {
            const latest = latestRuns.get(pipeline.id);
            return (
              <div key={pipeline.id} className="pipeline-card">
                <div className="pipeline-card-main">
                  <div className="pipeline-card-title">
                    <span
                      className="pipeline-status-dot"
                      data-status={latest?.status ?? 'idle'}
                      title={latest !== undefined ? t(RUN_STATUS_KEYS[latest.status] ?? 'pipelines.status.idle') : undefined}
                      aria-hidden="true"
                    />
                    <span className="pipeline-card-name mono">{pipeline.name}</span>
                    {latest !== undefined ? (
                      <span className="pipeline-card-run mono">
                        {t(RUN_STATUS_KEYS[latest.status] ?? 'pipelines.status.idle')}
                      </span>
                    ) : null}
                  </div>
                  {pipeline.description !== undefined && pipeline.description.length > 0 ? (
                    <div className="pipeline-card-desc">{pipeline.description}</div>
                  ) : null}
                  <div className="pipeline-card-meta mono">
                    {pipeline.steps.length} {t('pipelines.steps')} · {pipeline.onError} · {pipeline.id}
                  </div>
                </div>
                <div className="pipeline-card-actions">
                  <button
                    type="button"
                    className="btn-primary pipeline-action mono"
                    onClick={() => {
                      void run(pipeline.id).catch((err: unknown) => {
                        setEditorError(err instanceof Error ? err.message : String(err));
                      });
                    }}
                  >
                    {t('pipelines.run')}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary pipeline-action mono"
                    onClick={() => {
                      openEditor(pipeline);
                    }}
                  >
                    {t('pipelines.edit')}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary pipeline-action mono"
                    onClick={() => {
                      setDeleteTarget(pipeline);
                    }}
                  >
                    {t('pipelines.delete')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editorOpen ? (
        <div className="pipe-editor-overlay" role="presentation">
          <div className="pipe-editor" role="dialog" aria-modal="true" aria-label={t('pipelines.editor.title')}>
            <div className="pipe-editor-head">
              <span className="pipe-editor-title mono">{t('pipelines.editor.title')}</span>
              <button
                type="button"
                className="btn-secondary mono"
                onClick={() => {
                  setEditorOpen(false);
                }}
              >
                {t('pipelines.editor.cancel')}
              </button>
            </div>
            <textarea
              className="pipe-editor-text mono"
              spellCheck={false}
              value={editorText}
              onChange={(event) => {
                setEditorText(event.target.value);
              }}
            />
            {editorError !== null ? (
              <div className="automation-error mono" role="alert">
                {editorError}
              </div>
            ) : null}
            <div className="pipe-editor-foot">
              <span className="pipe-editor-hint mono">{t('pipelines.editor.hint')}</span>
              <button
                type="button"
                className="btn-primary mono"
                disabled={saving}
                onClick={() => {
                  void submitEditor();
                }}
              >
                {saving ? t('settings.loading') : t('pipelines.editor.save')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deleteTarget !== null ? (
        <ConfirmDialog
          title={t('pipelines.delete')}
          message={t('pipelines.deleteConfirm', { name: deleteTarget.name })}
          onConfirm={() => {
            void remove(deleteTarget.id).catch((err: unknown) => {
              setEditorError(err instanceof Error ? err.message : String(err));
            });
            setDeleteTarget(null);
          }}
          onCancel={() => {
            setDeleteTarget(null);
          }}
        />
      ) : null}
    </div>
  );
}
