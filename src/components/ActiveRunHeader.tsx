import type { RpcState } from '../../shared/types.js';
import { useI18n } from '../i18n/I18nProvider.js';
import './ActiveRunHeader.css';

/** UX workbench (audit): the stable Active Run Header above the chat stream.
 *  One place for project / model / run state / elapsed time / changed files
 *  and the run actions (abort, rerun, branch, approval indicator) — instead
 *  of them being scattered across the page header, composer and messages. */
export function ActiveRunHeader({
  rpcState,
  isAgentRunning,
  elapsedMs,
  changedFiles,
  pendingApprovals,
  onAbort,
  onRerun,
  onBranch,
}: {
  rpcState: RpcState | null;
  isAgentRunning: boolean;
  elapsedMs: number;
  changedFiles: number;
  pendingApprovals: number;
  onAbort: () => void;
  /** null = nothing to rerun. */
  onRerun: (() => void) | null;
  /** null = no branchable leaf (or non-pi agent). */
  onBranch: (() => void) | null;
}): React.JSX.Element {
  const { t } = useI18n();
  const model =
    rpcState?.model?.name !== undefined && rpcState.model.name.length > 0
      ? rpcState.model.name
      : rpcState?.model?.id ?? '—';
  const sessionName =
    rpcState?.sessionName !== undefined && rpcState.sessionName.length > 0
      ? rpcState.sessionName
      : '—';
  const elapsed = formatElapsed(elapsedMs);

  return (
    <div
      className="active-run-header mono"
      data-running={isAgentRunning}
      data-shot="active-run"
    >
      <span className="active-run-project" title={rpcState?.sessionFile ?? undefined}>
        {sessionName}
      </span>
      <span className="active-run-sep" aria-hidden="true">
        /
      </span>
      <span className="active-run-model" title={rpcState?.model?.provider ?? undefined}>
        {model}
      </span>
      <span className="active-run-state" data-running={isAgentRunning}>
        {isAgentRunning
          ? `${t('runHeader.running')} · ${elapsed}`
          : t('runHeader.idle')}
      </span>
      {changedFiles > 0 ? (
        <span className="active-run-files">
          {String(changedFiles)} {t('runHeader.filesChanged')}
        </span>
      ) : null}
      {pendingApprovals > 0 ? (
        <span className="active-run-approval">
          {t('runHeader.pendingApproval', { count: String(pendingApprovals) })}
        </span>
      ) : null}
      <span className="active-run-spacer" aria-hidden="true" />
      {onBranch !== null ? (
        <button
          type="button"
          className="active-run-action"
          title={t('runHeader.branch')}
          onClick={onBranch}
        >
          <span className="hico hico-arrow-triangle-divide" aria-hidden="true" />
          <span>{t('runHeader.branch')}</span>
        </button>
      ) : null}
      {onRerun !== null ? (
        <button
          type="button"
          className="active-run-action"
          title={t('runHeader.rerun')}
          onClick={onRerun}
        >
          <span className="hico hico-arrow-counterclockwise-clock" aria-hidden="true" />
          <span>{t('runHeader.rerun')}</span>
        </button>
      ) : null}
      {isAgentRunning ? (
        <button
          type="button"
          className="active-run-action"
          data-danger
          title={t('runHeader.abort')}
          onClick={onAbort}
        >
          <span className="hico hico-stop-fill" aria-hidden="true" />
          <span>{t('runHeader.abort')}</span>
        </button>
      ) : null}
    </div>
  );
}

/** mm:ss (or hh:mm:ss past an hour) for the run clock. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}
