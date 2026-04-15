import { useMemo } from 'react';
import { useGraphStore } from './store';
import { validateGraph, computeStats, Issue, IssueSeverity } from './validation';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

const SEVERITY_ORDER: IssueSeverity[] = ['error', 'warning', 'info'];

const SEVERITY_LABEL: Record<IssueSeverity, string> = {
  error: 'Errors',
  warning: 'Warnings',
  info: 'Info',
};

const SEVERITY_ICON: Record<IssueSeverity, string> = {
  error: '✗',
  warning: '⚠',
  info: 'ℹ',
};

export function IssuesModal({ isOpen, onClose }: Props) {
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const selectOnly = useGraphStore((s) => s.selectOnly);

  const issues = useMemo(() => validateGraph(nodes, edges), [nodes, edges]);
  const stats = useMemo(() => computeStats(nodes, edges), [nodes, edges]);

  const grouped = useMemo(() => {
    const out: Record<IssueSeverity, Issue[]> = { error: [], warning: [], info: [] };
    for (const i of issues) out[i.severity].push(i);
    return out;
  }, [issues]);

  if (!isOpen) return null;

  const onIssueClick = (issue: Issue) => {
    if (issue.blockId) selectOnly(issue.blockId);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <span>
            Issues{' '}
            {issues.length > 0 && (
              <span className="issues-count">({issues.length})</span>
            )}
          </span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal__body">
          <div className="graph-stats">
            <div className="graph-stats__row">
              <span className="graph-stats__metric">
                <span className="graph-stats__num">{stats.blocks}</span> blocks
              </span>
              <span className="graph-stats__metric">
                <span className="graph-stats__num">{stats.edges}</span> edges
              </span>
              {stats.blocks > 0 && (
                <>
                  <span className="graph-stats__metric">
                    <span className="graph-stats__num">{stats.longestChain}</span> longest chain
                  </span>
                  <span className="graph-stats__metric">
                    <span className="graph-stats__num">{stats.components}</span> component{stats.components === 1 ? '' : 's'}
                  </span>
                </>
              )}
              {stats.passing > 0 && (
                <span className="graph-stats__metric graph-stats__metric--pass">
                  <span className="graph-stats__num">{stats.passing}</span> passing
                </span>
              )}
              {stats.failing > 0 && (
                <span className="graph-stats__metric graph-stats__metric--fail">
                  <span className="graph-stats__num">{stats.failing}</span> failing
                </span>
              )}
            </div>
            {stats.blocks > 0 && (
              <div className="graph-stats__chips">
                {Object.entries(stats.languages).map(([lang, n]) => (
                  <span key={`l-${lang}`} className="graph-stats__chip">
                    {lang}: {n}
                  </span>
                ))}
                {Object.entries(stats.modes).map(([mode, n]) => (
                  <span key={`m-${mode}`} className="graph-stats__chip graph-stats__chip--mode">
                    {mode}: {n}
                  </span>
                ))}
              </div>
            )}
          </div>
          {issues.length === 0 ? (
            <div className="issues-empty">
              <div className="issues-empty__title">✓ No issues found</div>
              <div className="issues-empty__hint">
                All blocks look healthy — no failing tests, cycles, duplicate names, or TDD blocks missing tests.
              </div>
            </div>
          ) : (
            SEVERITY_ORDER.map((sev) =>
              grouped[sev].length === 0 ? null : (
                <div key={sev} className="issues-group">
                  <div className={`issues-group__header issues-group__header--${sev}`}>
                    {SEVERITY_ICON[sev]} {SEVERITY_LABEL[sev]} ({grouped[sev].length})
                  </div>
                  {grouped[sev].map((issue, idx) => (
                    <button
                      key={`${sev}-${idx}`}
                      className={`issue-row issue-row--${sev}`}
                      onClick={() => onIssueClick(issue)}
                      title={issue.blockId ? 'click to jump to block' : undefined}
                      disabled={!issue.blockId}
                    >
                      {issue.message}
                    </button>
                  ))}
                </div>
              ),
            )
          )}
        </div>
      </div>
    </div>
  );
}
