import { useMemo } from 'react';
import './charts.css';

/**
 * Minimal SVG mind map (P1-12 D, chart-library initial skeleton).
 * Center node + radial branches, pure data in / SVG out. Future batches
 * (skill graphs, session trees) feed the tree model.
 */
export interface MindNode {
  id: string;
  label: string;
  children?: MindNode[];
}

interface MindMapProps {
  root: MindNode;
  width?: number;
  height?: number;
}

const LEVEL_W = 130;
const NODE_H = 22;
const NODE_W = 92;
const V_GAP = 10;

interface PlacedNode {
  node: MindNode;
  x: number;
  y: number;
  parentX: number;
  parentY: number;
}

/** Number of leaves under a node (used to center the root/subtrees). */
function leafSpan(node: MindNode): number {
  const children = node.children ?? [];
  if (children.length === 0) {
    return 1;
  }
  return children.reduce((sum, child) => sum + leafSpan(child), 0);
}

export function MindMap({ root, width = 640, height = 400 }: MindMapProps): React.JSX.Element {
  const layout = useMemo<PlacedNode[]>(() => {
    const placed: PlacedNode[] = [];
    // Left-to-right layout: each depth is a column; subtrees are stacked
    // vertically with the parent centered over its span.
    const place = (node: MindNode, depth: number, y: number, parent: PlacedNode | null): number => {
      const x = depth * LEVEL_W + 60;
      const children = node.children ?? [];
      let cursor = y;
      if (children.length > 0) {
        for (const child of children) {
          const span = leafSpan(child);
          const childY = cursor + ((span - 1) * (NODE_H + V_GAP)) / 2;
          const next = place(child, depth + 1, cursor, null);
          placed.push({
            node: child,
            x: (depth + 1) * LEVEL_W + 60,
            y: childY,
            parentX: x,
            parentY: y + NODE_H / 2,
          });
          cursor = next;
        }
      }
      if (parent !== null) {
        // The root itself is pushed by the caller with explicit coordinates.
        placed.push({ node, x, y, parentX: parent.x, parentY: parent.y });
      }
      return cursor + NODE_H + V_GAP;
    };
    const rootSpan = leafSpan(root);
    const rootY = ((rootSpan - 1) * (NODE_H + V_GAP)) / 2;
    placed.push({ node: root, x: 60, y: rootY, parentX: 60, parentY: rootY });
    if ((root.children ?? []).length > 0) {
      place(root, 0, rootY, null);
    }
    return placed;
  }, [root]);

  const chartHeight = Math.max(height, layout.length * (NODE_H + V_GAP) + 20);

  return (
    <div className="chart-mindmap">
      <svg width={width} height={chartHeight} role="img" aria-label="mind map" className="chart-svg">
        {layout.map((item) =>
          item.parentX !== item.x ? (
            <line
              key={`edge-${item.node.id}`}
              x1={item.parentX}
              y1={item.parentY + NODE_H / 2}
              x2={item.x}
              y2={item.y + NODE_H / 2}
              className="chart-edge"
            />
          ) : null,
        )}
        {layout.map((item) => (
          <g key={item.node.id}>
            <rect
              x={item.x - NODE_W / 2}
              y={item.y}
              width={NODE_W}
              height={NODE_H}
              rx={5}
              className="chart-node"
            />
            <text
              x={item.x}
              y={item.y + NODE_H / 2 + 4}
              textAnchor="middle"
              className="chart-node-label mono"
            >
              {item.node.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
