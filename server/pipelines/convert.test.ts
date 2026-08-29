import { describe, expect, it } from 'vitest';
import {
  buildSoftConvertPrompt,
  hardConvert,
  parseAgentPipelineOutput,
  sanitizeTemplate,
} from './convert.js';
import type { PiCommand } from '../../shared/types.js';

const SKILL: PiCommand = {
  name: 'skill:github-roast',
  description: 'GitHub 账号评测：只用官方公开 API 采集证据，公式 {{input}} 不适用{{x}}。',
  source: 'skill',
  sourceInfo: { path: '/workspace/skills/github-roast/SKILL.md', source: 'auto' },
};

describe('sanitizeTemplate', () => {
  it('neutralizes template braces in untrusted text', () => {
    expect(sanitizeTemplate('a {{b}} c')).toBe('a 【b】 c');
    expect(sanitizeTemplate('plain')).toBe('plain');
  });
});

describe('hardConvert', () => {
  it('builds a valid one-step pipeline from skill metadata', () => {
    const pipeline = hardConvert(SKILL);
    expect(pipeline.id).toBe('conv-github-roast');
    expect(pipeline.name).toBe('github-roast 工程流');
    expect(pipeline.onError).toBe('stop');
    expect(pipeline.steps).toHaveLength(1);
    const step = pipeline.steps[0];
    expect(step?.type).toBe('prompt');
    expect(step?.prompt).toContain('/skill:github-roast');
    // description template braces are sanitized inside the prompt
    expect(step?.prompt).not.toContain('{{');
    expect(step?.prompt).toContain('【input】');
    expect(step?.prompt).toContain('【x】');
    expect(step?.prompt).toContain('GitHub 账号评测');
  });

  it('falls back to a default description when absent', () => {
    const withoutDescription: PiCommand = {
      name: 'skill:github-roast',
      source: 'skill',
      sourceInfo: { path: '/workspace/skills/github-roast/SKILL.md' },
    };
    const pipeline = hardConvert(withoutDescription);
    expect(pipeline.description).toContain('纳入工程流');
  });
});

describe('buildSoftConvertPrompt', () => {
  it('includes skill name, description and file path', () => {
    const prompt = buildSoftConvertPrompt(SKILL);
    expect(prompt).toContain('/skill:github-roast');
    expect(prompt).toContain('GitHub 账号评测');
    expect(prompt).toContain('SKILL.md');
    // skill-description braces are sanitized while the template-var examples
    // ({input} etc.) stay intact as instructions to the agent
    expect(prompt).toContain('公式 【input】 不适用【x】');
    expect(prompt).toContain('{{input}}');
  });
});

describe('parseAgentPipelineOutput', () => {
  const VALID = {
    id: 'flow-1',
    name: '测试流',
    onError: 'stop',
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
    steps: [
      { id: 's1', name: '读取', type: 'prompt', prompt: '读取技能' },
      { id: 's2', name: '执行', type: 'prompt', prompt: '执行' },
    ],
  };

  it('parses plain JSON output', () => {
    const pipeline = parseAgentPipelineOutput(JSON.stringify(VALID));
    expect(pipeline?.id).toBe('flow-1');
    expect(pipeline?.steps).toHaveLength(2);
  });

  it('fills missing timestamps (agents never emit them)', () => {
    const withoutTimestamps = { ...VALID } as Record<string, unknown>;
    delete withoutTimestamps['createdAt'];
    delete withoutTimestamps['updatedAt'];
    const pipeline = parseAgentPipelineOutput(JSON.stringify(withoutTimestamps));
    expect(pipeline?.id).toBe('flow-1');
    expect(typeof pipeline?.createdAt).toBe('string');
    expect(typeof pipeline?.updatedAt).toBe('string');
  });

  it('parses fenced JSON output with prose around it', () => {
    const text = `好的，定义如下：\n\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\`\n请保存。`;
    const pipeline = parseAgentPipelineOutput(text);
    expect(pipeline?.id).toBe('flow-1');
  });

  it('rejects invalid shapes', () => {
    expect(parseAgentPipelineOutput('not json at all')).toBeNull();
    expect(parseAgentPipelineOutput(JSON.stringify({ ...VALID, steps: [] }))).toBeNull();
    expect(parseAgentPipelineOutput('')).toBeNull();
  });

  it('rejects unknown step types', () => {
    expect(
      parseAgentPipelineOutput(
        JSON.stringify({
          ...VALID,
          steps: [{ id: 's1', name: 'x', type: 'magic', prompt: 'x' }],
        }),
      ),
    ).toBeNull();
  });
});
