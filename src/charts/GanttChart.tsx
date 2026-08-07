import { useMemo } from 'react';
import './charts.css';

/**
 * Minimal SVG Gantt chart (P1-12 D, chart-library initial skeleton).
 * Figure-model style: pure data in, SVG out — rendering detached from any
 * data source so later batches (pipeline run timelines, session stats) can
 * feed it. Timeline axis + task bars + optional dependency arrows.
 */
export interface GanttTask {
  id: string;
  label: string;
  /** Epoch ms or a plain number on the same scale as `range`. */
  start: number;
  end: number;
  status?: 'done' | 'running' | 'failed' | 'pending';
  /** Parent task id for a dependency arrow. */
  dependsOn?: string;
}

interface GanttChartProps {
  tasks: GanttTask[];
  /** [min, max] scale bounds; defaults to the task extremes. */
  range?: [number, number];
  width?: number;
  rowHeight?: number;
}

const BAR_H = 14;
const LABEL_W = 150;
const PAD_X = 8;
const PAD_Y = 10;
const AXIS_H = 22;
const HEADER_H = 24;

const STATUS_FILL: Record<NonNullable<GanttTask['status']>, string> = {
  done: '#2d9d78',
  running: '#005fb8',
  failed: '#dc322f',
  pending: '#8a8a8a',
};

export function GanttChart({
  tasks,
  range,
  width = 640,
  rowHeight = 26,
}: GanttChartProps): React.JSX.Element {
  const scale = useMemo(() => {
    const starts = tasks.map((t) => t.start);
    const ends = tasks.map((t) => t.end);
    const min = range?.[0] ?? (starts.length > 0 ? Math.min(...starts) : 0);
    const max = range?.[1] ?? (ends.length > 0 ? Math.max(...ends) : 1);
    const span = Math.max(1, max - min);
    const chartW = width - LABEL_W - PAD_X * 2;
    const x = (value: number): number =>
      LABEL_W + PAD_X + ((value - min) / span) * chartW;
    return { x, min, max };
  }, [tasks, range, width]);

  const chartH = HEADER_H + AXIS_H + tasks.length * rowHeight + PAD_Y;
  const byId = new Map(tasks.map((task) => [task.id, task] as const));

  return (
    <div className="chart-gantt">
      <svg
        width={width}
        height={chartH}
        role="img"
        aria-label="gantt chart"
        className="chart-svg"
      >
        <g className="chart-grid">
          {Array.from({ length: 6 }, (_, i) => {
            const ratio = i / 5;
            const value = scale.min + (scale.max - scale.min) * ratio;
            const x = LABEL_W + PAD_X + ratio * (width - LABEL_W - PAD_X * 2);
            return (
              <g key={i}>
                <line x1={x} y1={HEADER_H} x2={x} y2={chartH - PAD_Y} />
                <text x={x} y={HEADER_H - 6} className="chart-axis mono" textAnchor="middle">
                  {formatAxis(value)}
                </text>
              </g>
            );
          })}
        </g>
        {tasks.map((task, index) => {
          const x1 = scale.x(task.start);
          const x2 = scale.x(task.end);
          const y = HEADER_H + AXIS_H + index * rowHeight + rowHeight / 2;
          const dep = task.dependsOn !== undefined ? byId.get(task.dependsOn) : undefined;
          return (
            <g key={task.id}>
              <text x={LABEL_W - 8} y={y + 4} textAnchor="end" className="chart-label mono">
                {task.label}
              </text>
              <rect
                x={x1}
                y={y - BAR_H / 2}
                width={Math.max(2, x2 - x1)}
                height={BAR_H}
                rx={3}
                fill={STATUS_FILL[task.status ?? 'pending']}
              />
              {dep !== undefined ? (
                <line
                  x1={scale.x(dep.end) + 2}
                  y1={HEADER_H + AXIS_H + index * rowHeight + rowHeight / 2}
                  x2={x1 - 2}
                  y2={y}
                  className="chart-arrow"
                />
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function formatAxis(value: number): string {
  if (value > 100_000_000_000) {
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return String(Math.round(value));
}
