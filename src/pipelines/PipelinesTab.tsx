import { useEffect, useMemo, useState } from 'react';
import type { PiCommand, Pipeline } from '../../shared/types.js';
import { api } from '../api/client.js';
import { usePipelines, selectVisibleRuns } from './usePipelines.js';
import { RunTimeline } from './RunTimeline.js';
import { PipelineVisualEditor } from './PipelineVisualEditor.js';
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

/**
 * Pipelines tab (P1-02-C4): definition list with run status lights, JSON
 * editor modal for create/edit, guarded delete. The live run timeline view
 * lands in C5.
 */
export function PipelinesTab(): React.JSX.Element {
  const { t } = useI18n();
  const { pipelines, runs, error, save, remove, run, abort, approve } = usePipelines();
  /** UX workbench: the visual pipeline editor (execution band + inspector +
   *  JSON source mode) replaces the plain JSON modal as the main entry. */
  const [editTarget, setEditTarget] = useState<Pipeline | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Pipeline | null>(null);
  const [runTarget, setRunTarget] = useState<Pipeline | null>(null);
  const [runInput, setRunInput] = useState('');
  // Run targeting: optional working folder + agent (per run, not in the DSL).
  const [runCwd, setRunCwd] = useState('');
  const [runAgent, setRunAgent] = useState<'pi' | 'codex'>('pi');
  const [skills, setSkills] = useState<PiCommand[]>([]);
  const [selectedSkill, setSelectedSkill] = useState('');
  const [softConfirm, setSoftConfirm] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);

  // Skill directory for the import surface (P1-10 A).
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const commands = await api.commands();
        if (!cancelled) {
          setSkills(commands.filter((c) => c.source === 'skill'));
        }
      } catch {
        // skills unavailable; the import surface stays empty
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const convertSkill = async (mode: 'hard' | 'soft'): Promise<void> => {
    if (selectedSkill.length === 0) {
      return;
    }
    setConverting(true);
    setEditorError(null);
    try {
      const { pipeline } =
        mode === 'hard'
          ? await api.convertPipelineHard(selectedSkill)
          : await api.convertPipelineSoft(selectedSkill);
      setEditTarget(pipeline);
    } catch (err) {
      setEditorError(t('pipelines.convert.failed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setConverting(false);
    }
  };

  const visibleRuns = useMemo(() => selectVisibleRuns(runs), [runs]);

  const latestRuns = useMemo(() => {
    const byPipeline = new Map<string, (typeof runs)[number]>();
    for (const record of runs) {
      const existing = byPipeline.get(record.pipelineId);
      if (existing === undefined || record.startedAt > existing.startedAt) {
        byPipeline.set(record.pipelineId, record);
      }
    }
    return byPipeline;
  }, [runs]);

  const openEditor = (pipeline: Pipeline | null): void => {
    const now = new Date().toISOString();
    const base = pipeline ?? {
      id: `pipeline-${String(Date.now())}`,
      name: t('pipelines.new'),
      steps: [
        { id: 's1', name: t('pipelines.step.prompt'), type: 'prompt', prompt: '分析 {{input}}，输出计划' },
        { id: 's2', name: t('pipelines.step.approval'), type: 'approval' },
      ],
      onError: 'stop' as const,
      createdAt: now,
      updatedAt: now,
    };
    setEditTarget(base);
    setEditorError(null);
  };

  const submitEditor = async (pipeline: Pipeline): Promise<void> => {
    setEditorError(null);
    setSaving(true);
    try {
      await save(pipeline);
      setEditTarget(null);
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

      {skills.length > 0 ? (
        <div className="pipelines-convert">
          <div className="pipelines-convert-head">
            <span className="pipelines-convert-title mono">{t('pipelines.convert.title')}</span>
            <span className="pipelines-convert-note mono">{t('pipelines.convert.note')}</span>
          </div>
          <div className="pipelines-convert-row">
            <select
              className="pipelines-convert-select mono"
              value={selectedSkill}
              onChange={(event) => {
                setSelectedSkill(event.target.value);
              }}
              aria-label={t('pipelines.convert.select')}
            >
              <option value="">{t('pipelines.convert.select')}</option>
              {skills.map((skill) => (
                <option key={skill.name} value={skill.name}>
                  {skill.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn-secondary pipeline-action mono"
              disabled={selectedSkill.length === 0 || converting}
              onClick={() => {
                void convertSkill('hard');
              }}
            >
              {t('pipelines.convert.hard')}
            </button>
            <button
              type="button"
              className="btn-secondary pipeline-action mono"
              disabled={selectedSkill.length === 0 || converting}
              onClick={() => {
                setSoftConfirm(selectedSkill);
              }}
            >
              {t('pipelines.convert.soft')}
            </button>
          </div>
          {converting ? (
            <p className="pipelines-convert-running mono" role="status">
              {t('pipelines.convert.running')}
            </p>
          ) : null}
        </div>
      ) : null}

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
                      setRunInput('');
                      setRunTarget(pipeline);
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

      {visibleRuns.length > 0 ? (
        <div className="pipelines-runs">
          <div className="pipelines-runs-title mono">{t('pipelines.runView')}</div>
          {visibleRuns.map((record) => (
            <RunTimeline
              key={record.runId}
              run={record}
              onAbort={(runId) => {
                void abort(runId).catch((err: unknown) => {
                  setEditorError(err instanceof Error ? err.message : String(err));
                });
              }}
              onApprove={(runId, approved) => {
                void approve(runId, approved).catch((err: unknown) => {
                  setEditorError(err instanceof Error ? err.message : String(err));
                });
              }}
            />
          ))}
        </div>
      ) : pipelines !== null && pipelines.length > 0 ? (
        <p className="automation-hint">{t('pipelines.noActiveRuns')}</p>
      ) : null}

      {editTarget !== null ? (
        <div className="pipe-editor-overlay" role="presentation">
          <div
            className="pipe-editor pipe-editor-visual"
            role="dialog"
            aria-modal="true"
            aria-label={t('pipelines.editor.title')}
          >
            {editorError !== null ? (
              <div className="automation-error mono" role="alert">
                {editorError}
              </div>
            ) : null}
            <PipelineVisualEditor
              initial={editTarget}
              saving={saving}
              onSave={(pipeline) => {
                void submitEditor(pipeline);
              }}
              onCancel={() => {
                setEditTarget(null);
              }}
            />
          </div>
        </div>
      ) : null}

      {softConfirm !== null ? (
        <ConfirmDialog
          title={t('pipelines.convert.soft')}
          message={t('pipelines.convert.softConfirm')}
          danger={false}
          confirmLabel={t('pipelines.runInput.start')}
          onConfirm={() => {
            void convertSkill('soft');
            setSoftConfirm(null);
          }}
          onCancel={() => {
            setSoftConfirm(null);
          }}
        />
      ) : null}

      {runTarget !== null ? (
        <div className="pipe-editor-overlay" role="presentation">
          <div
            className="pipe-editor pipe-run-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('pipelines.runInput.title', { name: runTarget.name })}
          >
            <div className="pipe-editor-head">
              <span className="pipe-editor-title mono">
                {t('pipelines.runInput.title', { name: runTarget.name })}
              </span>
              <button
                type="button"
                className="btn-secondary mono"
                onClick={() => {
                  setRunTarget(null);
                }}
              >
                {t('pipelines.editor.cancel')}
              </button>
            </div>
            <input
              className="pipe-run-input mono"
              value={runInput}
              placeholder={t('pipelines.runInput.placeholder')}
              onChange={(event) => {
                setRunInput(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  // runTarget is narrowed to Pipeline inside this branch.
                  void run(runTarget.id, runInput, {
                    ...(runCwd.trim().length > 0 ? { cwd: runCwd.trim() } : {}),
                    agent: runAgent,
                  }).catch((err: unknown) => {
                    setEditorError(err instanceof Error ? err.message : String(err));
                  });
                  setRunTarget(null);
                }
              }}
            />
            <div className="pipe-run-targeting">
              <div className="pipe-run-field">
                <span className="pipe-run-field-label mono">{t('pipelines.runInput.folder')}</span>
                <input
                  className="pipe-run-cwd mono"
                  value={runCwd}
                  placeholder={t('pipelines.runInput.folderPlaceholder')}
                  onChange={(event) => {
                    setRunCwd(event.target.value);
                  }}
                />
              </div>
              <div className="pipe-run-field">
                <span className="pipe-run-field-label mono">{t('pipelines.runInput.agent')}</span>
                <div className="pipe-run-agents">
                  {(['pi', 'codex'] as const).map((value) => (
                    <label key={value} className="pipe-run-agent mono">
                      <input
                        type="radio"
                        name="pipe-run-agent"
                        checked={runAgent === value}
                        onChange={() => {
                          setRunAgent(value);
                        }}
                      />
                      {value === 'pi' ? t('pipelines.runInput.agentPi') : t('pipelines.runInput.agentCodex')}
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="pipe-editor-foot">
              <span className="pipe-editor-hint mono">{runTarget.steps.length} {t('pipelines.steps')}</span>
              <button
                type="button"
                className="btn-primary mono"
                onClick={() => {
                  // runTarget is narrowed to Pipeline inside this branch.
                  void run(runTarget.id, runInput, {
                    ...(runCwd.trim().length > 0 ? { cwd: runCwd.trim() } : {}),
                    agent: runAgent,
                  }).catch((err: unknown) => {
                    setEditorError(err instanceof Error ? err.message : String(err));
                  });
                  setRunTarget(null);
                }}
              >
                {t('pipelines.runInput.start')}
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
