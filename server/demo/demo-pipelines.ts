/**
 * Demo-mode pipeline seeds (P1-02-C6). kMode data isolation: these are
 * synthetic definitions stored in the throwaway temp store only — the demo
 * backend never writes PiHub-owned state and never executes pipelines
 * (write routes return 503). Content is desensitized showcase material.
 */
import type { Pipeline } from '../../shared/types.js';
import type { PipelineStore } from '../pipelines/store.js';

const SEED_PIPELINES: Pipeline[] = [
  {
    id: 'demo-publish',
    name: '双仓发布',
    description: '检查仓库状态，确认后同步推送到双仓库。',
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
    onError: 'stop',
    steps: [
      {
        id: 's1',
        name: '检查状态',
        type: 'prompt',
        prompt: '检查 {{cwd}} 的 git 状态：未提交改动、分支、与上游的差异。输出简洁清单。',
      },
      { id: 's2', name: '确认发布', type: 'approval', requiresApproval: true },
      {
        id: 's3',
        name: '同步双仓',
        type: 'prompt',
        prompt: '基于以上检查结果 {{lastOutput}}，提交并推送到两个仓库，完成后总结。',
      },
    ],
  },
  {
    id: 'demo-review',
    name: '页面审查',
    description: '对目标页面做一轮可访问性与样式审查，输出修复清单。',
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
    onError: 'retry',
    steps: [
      {
        id: 's1',
        name: '审查',
        type: 'prompt',
        prompt: '审查 {{input}}：可访问性（aria/焦点/对比度）与瑞士风格一致性，输出问题清单。',
      },
      {
        id: 's2',
        name: '修复',
        type: 'prompt',
        prompt: '按清单 {{lastOutput}} 逐项修复，每项说明改动。',
      },
    ],
  },
];

/** Seeds the throwaway demo store (call only in demo mode). */
export function seedDemoPipelines(store: PipelineStore): void {
  for (const pipeline of SEED_PIPELINES) {
    store.save(pipeline);
  }
}
