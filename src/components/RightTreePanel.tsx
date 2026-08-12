import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SessionEntry, SessionTreeNode } from '../../shared/types.js';
import { api } from '../api/client.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { mainlineIdsOf, roleIconOf, summaryOf } from '../chat/sessionTree.js';
import './RightTreePanel.css';

/**
 * P1-08b: session tree for the right workbench (会话树 tab) — pi-only.
 * Uses the get_tree RPC passthrough of the ACTIVE pi session and renders a
 * COMPACT lazy tree: only root nodes render initially, subtrees expand on
 * demand, so a 700+ node session never floods the DOM. User entries on the
 * mainline can fork (I-06); clicking a user entry jumps the chat stream to
 * that prompt (CustomEvent consumed by ChatPage).
 */
export function RightTreePanel(): React.JSX.Element {
  const { t } = useI18n();
  const [tree, setTree] = useState<SessionTreeNode[] | null>(null);
  const [leafId, setLeafId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [forking, setForking] = useState<string | null>(null);

  const load = useCallback((): void => {
    setError(null);
    api
      .rpcTree()
      .then((response) => {
        setTree(response.tree);
        setLeafId(response.leafId);
      })
      .catch((reason: unknown) => {
        setTree(null);
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const mainline = useMemo(() => mainlineIdsOf(tree ? collectEntries(tree) : [], leafId), [tree, leafId]);

  const toggle = useCallback((nodeId: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  const fork = useCallback(
    (entryId: string): void => {
      setForking(entryId);
      api
        .forkSession(entryId)
        .then(() => {
          load();
        })
        .catch((reason: unknown) => {
          setError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          setForking(null);
        });
    },
    [load],
  );

  /** Jump the chat stream to this user prompt (matched by its full text). */
  const jump = useCallback((entry: SessionEntry): void => {
    let text = '';
    const message = entry.message;
    if (message?.role === 'user') {
      const content = message.content;
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .filter((block) => block.type === 'text')
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join(' ')
          .trim();
      }
    }
    window.dispatchEvent(new CustomEvent('pihub:tree-jump', { detail: { text } }));
  }, []);

  const renderLevel = (nodes: SessionTreeNode[], depth: number): React.JSX.Element[] => {
    const rows: React.JSX.Element[] = [];
    for (const node of nodes) {
      const entry = node.entry;
      const hasChildren = node.children.length > 0;
      const isOpen = expanded.has(entry.id);
      const onMainline = mainline.has(entry.id);
      const isUser = entry.message?.role === 'user';
      rows.push(
        <div key={entry.id}>
          <button
            type="button"
            className="right-tree-row mono"
            data-offbranch={!onMainline}
            data-user={isUser}
            style={{ paddingLeft: `${String(6 + depth * 14)}px` }}
            onClick={() => {
              if (hasChildren) {
                toggle(entry.id);
              }
              if (isUser) {
                jump(entry);
              }
            }}
          >
            <span className="right-tree-caret" aria-hidden="true">
              {hasChildren ? (isOpen ? '−' : '+') : ''}
            </span>
            <span className="right-tree-glyph" aria-hidden="true">
              {roleIconOf(entry)}
            </span>
            <span className="right-tree-label" title={summaryOf(entry)}>
              {summaryOf(entry)}
            </span>
            {isUser && onMainline ? (
              <span
                role="button"
                tabIndex={0}
                className="right-tree-fork mono"
                title={t('session.fork')}
                onClick={(event) => {
                  event.stopPropagation();
                  fork(entry.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.stopPropagation();
                    fork(entry.id);
                  }
                }}
              >
                {forking === entry.id ? '…' : '⧉'}
              </span>
            ) : null}
          </button>
          {isOpen ? renderLevel(node.children, depth + 1) : null}
        </div>,
      );
    }
    return rows;
  };

  return (
    <div className="right-tree">
      <div className="right-tree-head mono">
        <span>{t('rightSidebar.tree')}</span>
        <button
          type="button"
          className="right-tree-refresh mono"
          title={t('rightSidebar.refresh')}
          onClick={load}
        >
          ⟳
        </button>
      </div>
      {error !== null ? (
        <p className="right-tree-error mono" role="alert">
          {error}
        </p>
      ) : null}
      {tree === null && error === null ? (
        <p className="right-tree-empty mono">{t('settings.loading')}</p>
      ) : null}
      {tree !== null && tree.length === 0 ? (
        <p className="right-tree-empty mono">{t('session.tree.empty')}</p>
      ) : null}
      {tree !== null && tree.length > 0 ? (
        <div className="right-tree-body" role="tree" aria-label={t('rightSidebar.tree')}>
          {renderLevel(tree, 0)}
        </div>
      ) : null}
    </div>
  );
}

/** Flattens node entries for mainline computation (ids are unique). */
function collectEntries(nodes: SessionTreeNode[], out: Array<SessionTreeNode['entry']> = []): SessionTreeNode['entry'][] {
  for (const node of nodes) {
    out.push(node.entry);
    collectEntries(node.children, out);
  }
  return out;
}
