import { useMemo } from 'react';
import type { SessionDetail } from '../../shared/types.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { flattenTree, mainlineIdsOf, roleIconOf, summaryOf, type FlattenedNode } from '../chat/sessionTree.js';
import './SessionTreeView.css';

/**
 * P1-05: session tree visualization (B-05 backlog — branch timeline / node
 * labels / one-click fork). Renders the JSONL-rebuilt DAG (detail.tree) so any
 * historical session can be inspected offline and consistently with the
 * message stream. Fork stays on user entries of the mainline (I-06 contract:
 * pi `fork` is before-user only) and goes through the same RPC path as the
 * message stream's fork buttons.
 */

function timeOf(iso: string | undefined, intlTag: string): string {
  if (iso === undefined) {
    return '';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return new Intl.DateTimeFormat(intlTag, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

interface SessionTreeViewProps {
  detail: SessionDetail;
  /** Fork an entry (I-06: only user entries on the mainline can fork). */
  onFork: (entryId: string) => void;
}

export function SessionTreeView({ detail, onFork }: SessionTreeViewProps): React.JSX.Element {
  const { t, intlTag } = useI18n();

  const mainlineIds = useMemo(
    () => mainlineIdsOf(detail.entries, detail.leafId),
    [detail],
  );

  const nodes = useMemo(() => {
    const out: FlattenedNode[] = [];
    flattenTree(detail.tree, 0, out);
    return out;
  }, [detail]);

  if (nodes.length === 0) {
    return <p className="tree-empty mono">{t('session.tree.empty')}</p>;
  }

  return (
    <div className="session-tree" role="tree" aria-label={t('session.tree.title')}>
      {nodes.map(({ entry, depth }) => {
        const onMainline = mainlineIds.has(entry.id);
        const isUser = entry.message?.role === 'user';
        return (
          <div
            key={entry.id}
            className="tree-node"
            role="treeitem"
            style={{ paddingLeft: `${String(depth * 16)}px` }}
            data-offbranch={!onMainline}
          >
            <span className="tree-node-glyph mono" aria-hidden="true">
              {roleIconOf(entry)}
            </span>
            <span className="tree-node-time mono">{timeOf(entry.timestamp, intlTag)}</span>
            <span className="tree-node-label mono" title={summaryOf(entry)}>
              {summaryOf(entry)}
            </span>
            {isUser && onMainline ? (
              <button
                type="button"
                className="tree-node-fork"
                onClick={() => {
                  onFork(entry.id);
                }}
              >
                <span className="hico hico-square-grid" aria-hidden="true" />
                {t('session.fork')}
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
