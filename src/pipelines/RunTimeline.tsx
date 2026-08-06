import { useState } from 'react';
import type { PipelineRunRecord } from '../../shared/types.js';
import { useI18n, type MessageKey } from '../i18n/I18nProvider.js';

const STEP_STATUS_KEYS: Record<string, MessageKey> = {
  pending: 'pipelines.step.pending',
  running: 'pipelines.step.running',
  succeeded: 'pipelines.step.succeeded',
  failed: 'pipelines.step.failed',
  skipped: 'pipelines.step.skipped',
  'awaiting-approval': 'pipelines.step.awaiting-approval',
};

function formatSeconds(ms: number): number {
  return Math.max(0, Math.round(ms / 1000));
}

interface RunTimelineProps {
  run: PipelineRunRecord;
  onAbort: (runId: string) => void;
  onApprove: (runId: string, approved: boolean) => void;
}

/**
 * Live run timeline (P1-02-C5): per-step status rows with expandable
 * input/output/error details, approval actions on awaiting steps, abort
 * while running. State updates arrive via SSE pipeline_step snapshots.
 */
export function RunTimeline({ run, onAbort, onApprove }: RunTimelineProps): React.JSX.Element {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<string | null>(null);
  const running = run.status === 'running' || run.status === 'idle';

  return (
    <div className="run-timeline" data-run-status={run.status}>
      <div className="run-timeline-head">
        <div className="run-timeline-title">
          <span className="pipeline-status-dot" data-status={run.status} aria-hidden="true" />
          <span className="run-timeline-name mono">{run.pipelineName}</span>
          <span className="run-timeline-meta mono">
            {run.runId} · {new Date(run.startedAt).toLocaleTimeString()}
          </span>
        </div>
        {running ? (
          <button
            type="button"
            className="btn-secondary mono run-timeline-abort"
            onClick={() => {
              onAbort(run.runId);
            }}
          >
            {t('pipelines.abort')}
          </button>
        ) : null}
      </div>
      {run.input.length > 0 ? (
        <div className="run-timeline-input mono">
          {t('pipelines.step.input')}: {run.input}
        </div>
      ) : null}
      <div className="run-timeline-steps">
        {run.steps.map((step) => {
          const key = step.stepId;
          const isExpanded = expanded === key;
          const statusKey = STEP_STATUS_KEYS[step.status] ?? 'pipelines.step.pending';
          const duration =
            step.startedAt !== undefined && step.finishedAt !== undefined
              ? formatSeconds(step.finishedAt - step.startedAt)
              : null;
          return (
            <div key={key} className="run-step" data-step-status={step.status}>
              <div className="run-step-row">
                <button
                  type="button"
                  className="run-step-toggle"
                  onClick={() => {
                    setExpanded(isExpanded ? null : key);
                  }}
                  aria-expanded={isExpanded}
                >
                  <span className="run-step-dot" data-status={step.status} aria-hidden="true" />
                  <span className="run-step-name mono">{step.name}</span>
                  <span className="run-step-type mono">{step.type}</span>
                </button>
                <span className="run-step-meta mono">
                  {step.status === 'running' && step.attempts !== undefined && step.attempts > 1
                    ? `${t('pipelines.step.attempts', { n: String(step.attempts) })} · `
                    : ''}
                  {step.status === 'awaiting-approval' && running ? (
                    <span className="run-step-actions">
                      <button
                        type="button"
                        className="btn-primary run-step-action mono"
                        onClick={() => {
                          onApprove(run.runId, true);
                        }}
                      >
                        {t('pipelines.approve')}
                      </button>
                      <button
                        type="button"
                        className="btn-secondary run-step-action mono"
                        onClick={() => {
                          onApprove(run.runId, false);
                        }}
                      >
                        {t('pipelines.reject')}
                      </button>
                    </span>
                  ) : (
                    <>
                      {duration !== null
                        ? `${t('pipelines.step.duration', { seconds: String(duration) })} · `
                        : ''}
                      {t(statusKey)}
                    </>
                  )}
                </span>
              </div>
              {isExpanded ? (
                <div className="run-step-detail">
                  {step.input !== undefined ? (
                    <div className="run-step-detail-block">
                      <div className="run-step-detail-label mono">{t('pipelines.step.input')}</div>
                      <pre className="run-step-detail-pre mono">{step.input}</pre>
                    </div>
                  ) : null}
                  {step.output !== undefined ? (
                    <div className="run-step-detail-block">
                      <div className="run-step-detail-label mono">{t('pipelines.step.output')}</div>
                      <pre className="run-step-detail-pre mono">{step.output}</pre>
                    </div>
                  ) : null}
                  {step.toolOutput !== undefined ? (
                    <div className="run-step-detail-block">
                      <div className="run-step-detail-label mono">{t('pipelines.step.tool')}</div>
                      <pre className="run-step-detail-pre mono">{step.toolOutput}</pre>
                    </div>
                  ) : null}
                  {step.error !== undefined ? (
                    <div className="run-step-detail-block">
                      <div className="run-step-detail-label mono">{t('pipelines.step.error')}</div>
                      <pre className="run-step-detail-pre mono run-step-detail-error">{step.error}</pre>
                    </div>
                  ) : null}
                  {step.attempts !== undefined && step.attempts > 1 ? (
                    <div className="run-step-detail-meta mono">
                      {t('pipelines.step.attempts', { n: String(step.attempts) })}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
