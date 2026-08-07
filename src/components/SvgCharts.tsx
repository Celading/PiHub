import type { DayStatRow } from '../../shared/types.js';

/**
 * P1-04: zero-dependency lightweight SVG charts for the stats page.
 * Pure viewBox SVGs (no chart library); colors come from CSS variables so the
 * light/dark themes apply unchanged. Both charts render an empty-state text
 * instead of dividing by zero when there is no data.
 */

export interface ShareRow {
  label: string;
  value: number;
}

interface CostShareChartProps {
  rows: ShareRow[];
  total: number;
  formatValue: (value: number) => string;
  emptyText: string;
}

const SHARE_WIDTH = 480;
const SHARE_ROW_H = 20;
const SHARE_LABEL_W = 176;
const SHARE_VALUE_W = 84;
const SHARE_BAR_MAX = SHARE_WIDTH - SHARE_LABEL_W - SHARE_VALUE_W - 12;
/** Approximate mono glyph advance at the 11px chart label size. */
const MONO_GLYPH_PX = 6.6;

function truncateLabel(label: string, maxWidth: number): string {
  const maxChars = Math.floor(maxWidth / MONO_GLYPH_PX);
  return label.length > maxChars ? `${label.slice(0, maxChars - 1)}…` : label;
}

export function CostShareChart({ rows, total, formatValue, emptyText }: CostShareChartProps): React.JSX.Element {
  const visible = rows.filter((row) => row.value > 0);
  if (total <= 0 || visible.length === 0) {
    return <p className="chart-empty mono">{emptyText}</p>;
  }
  const height = visible.length * SHARE_ROW_H + 8;
  return (
    <svg className="chart-svg" viewBox={`0 0 ${String(SHARE_WIDTH)} ${String(height)}`} role="img" aria-hidden="true">
      {visible.map((row, index) => {
        const y = index * SHARE_ROW_H + 6;
        const barW = Math.max((row.value / total) * SHARE_BAR_MAX, 1);
        return (
          <g key={row.label}>
            <text className="chart-label mono" x={0} y={y + 9}>
              <title>{row.label}</title>
              {truncateLabel(row.label, SHARE_LABEL_W)}
            </text>
            <rect className="chart-bar" x={SHARE_LABEL_W + 4} y={y} width={barW} height={10} rx={1} />
            <text className="chart-value mono" x={SHARE_WIDTH} y={y + 9} textAnchor="end">
              {formatValue(row.value)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

interface DayTrendChartProps {
  days: DayStatRow[];
  formatCost: (value: number) => string;
  formatTokens: (value: number) => string;
  emptyText: string;
}

const TREND_W = 480;
const TREND_H = 176;
const TREND_PAD_TOP = 14;
const TREND_PAD_BOTTOM = 22;

export function DayTrendChart({ days, formatCost, formatTokens, emptyText }: DayTrendChartProps): React.JSX.Element {
  if (days.length === 0) {
    return <p className="chart-empty mono">{emptyText}</p>;
  }
  const maxCost = Math.max(...days.map((day) => day.cost), 0);
  const plotH = TREND_H - TREND_PAD_TOP - TREND_PAD_BOTTOM;
  const band = TREND_W / days.length;
  const barW = Math.min(band * 0.56, 26);
  const labelEvery = days.length > 12 ? Math.ceil(days.length / 12) : 1;
  return (
    <svg className="chart-svg" viewBox={`0 0 ${String(TREND_W)} ${String(TREND_H)}`} role="img" aria-hidden="true">
      <line
        className="chart-axis"
        x1={0}
        y1={TREND_H - TREND_PAD_BOTTOM}
        x2={TREND_W}
        y2={TREND_H - TREND_PAD_BOTTOM}
      />
      {days.map((day, index) => {
        const x = index * band + band / 2;
        const h = maxCost > 0 ? (day.cost / maxCost) * plotH : 0;
        const y = TREND_H - TREND_PAD_BOTTOM - h;
        return (
          <g key={day.day}>
            <rect className="chart-bar" x={x - barW / 2} y={y} width={barW} height={Math.max(h, 1)} rx={1}>
              <title>{`${day.day} · ${formatCost(day.cost)} · ${formatTokens(day.tokens.total)}`}</title>
            </rect>
            {index % labelEvery === 0 ? (
              <text className="chart-label mono" x={x} y={TREND_H - 6} textAnchor="middle">
                {day.day.slice(5)}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
