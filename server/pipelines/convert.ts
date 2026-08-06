/**
 * Skill → Pipeline conversion (P1-10 A, PiHub-exclusive / HaomoKit
 * generalized capability).
 *
 * Two intents, kept semantically distinct:
 * - HARD: pure algorithmic conversion, zero token cost. Generates a
 *   deterministic one-step pipeline from the skill's metadata.
 * - SOFT: agent-assisted conversion, token cost. The real pi agent reads the
 *   skill and produces a tailored pipeline definition; the caller must have
 *   already shown a token-usage confirmation to the operator.
 *
 * Both outputs are plain Pipeline objects; persisting them stays the caller's
 * job (the UI previews before saving).
 */
import type { PiCommand, Pipeline, PipelineRunRecord } from '../../shared/types.js';
import { pipelineSchema } from '../../shared/schemas.js';
import type { PipelineEngine } from './engine.js';

/** Hard-convert a skill command into a deterministic pipeline. */
export function hardConvert(command: PiCommand): Pipeline {
  const now = new Date().toISOString();
  const skillName = command.name; // e.g. "skill:github-roast"
  const displayName = skillName.replace(/^skill:/, '');
  const description = command.description ?? `将 ${displayName} 纳入工程流`;
  const idBase = `conv-${displayName.replace(/[^a-zA-Z0-9-]/g, '-')}`;
  return {
    id: idBase,
    name: `${displayName} 工程流`,
    description,
    createdAt: now,
    updatedAt: now,
    onError: 'stop',
    steps: [
      {
        id: 's1',
        name: '执行技能',
        type: 'prompt',
        // Template braces in the description must not collide with the
        // {{var}} interpolation syntax.
        prompt: `调用 /${skillName} 完成任务。技能说明：${sanitizeTemplate(description).slice(0, 200)}`,
      },
    ],
  };
}

/** Escapes `{{` / `}}` so untrusted skill text stays inert in templates. */
export function sanitizeTemplate(text: string): string {
  return text.replace(/\{\{/g, '【').replace(/\}\}/g, '】');
}

/** Prompt that asks the agent to produce a pipeline definition (soft path). */
export function buildSoftConvertPrompt(command: PiCommand): string {
  const path = command.sourceInfo?.path;
  const location = typeof path === 'string' && path.length > 0 ? path : '(未提供路径)';
  const description = command.description ?? '';
  return [
    '请把以下技能转换为 PiHub 工程流（Pipeline）定义。',
    `技能名：/${command.name}`,
    `技能说明：${sanitizeTemplate(description)}`,
    `技能文件：${location}`,
    '',
    '转换要求：',
    '- 只输出一个 JSON 对象，不要任何解释文字或代码块标记',
    '- JSON 结构：{"id":string,"name":string,"description":string,"onError":"stop"|"skip"|"retry","steps":[{id,name,type,prompt}]}',
    '- steps 至少 2 步：第一步让 agent 读取技能文件并理解（type=prompt），第二步执行技能（type=prompt）',
    '- 步骤 type 只能是 prompt / steer / approval / setModel / setThinking',
    '- 模板可用变量：{{input}} {{lastOutput}} {{lastToolOutput}} {{sessionName}} {{cwd}}',
    '- id 用英文短横线（如 github-roast-flow），name 用中文或技能名',
  ].join('\n');
}

/** Extracts a valid Pipeline from the agent's output text. */
export function parseAgentPipelineOutput(text: string): Pipeline | null {
  const trimmed = text.trim();
  // Agent may wrap JSON in ```json fences; take the first {...} span.
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    // Agents never emit timestamps; a converted definition is a new one.
    const now = new Date().toISOString();
    const withTimestamps =
      typeof parsed === 'object' && parsed !== null
        ? {
            ...(parsed as Record<string, unknown>),
            createdAt:
              typeof (parsed as Record<string, unknown>)['createdAt'] === 'string'
                ? (parsed as Record<string, unknown>)['createdAt']
                : now,
            updatedAt: now,
          }
        : parsed;
    const result = pipelineSchema.safeParse(withTimestamps);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

const SOFT_CONVERT_TIMEOUT_MS = 3 * 60 * 1000;
const SOFT_CONVERT_POLL_MS = 1000;

/**
 * Soft path: runs the conversion prompt on the real pi session via the
 * engine (a temporary one-shot pipeline), waits for completion, parses the
 * agent's JSON output, and returns the validated pipeline.
 */
export async function softConvert(
  engine: PipelineEngine,
  command: PiCommand,
  timeoutMs: number = SOFT_CONVERT_TIMEOUT_MS,
): Promise<Pipeline> {
  const now = new Date().toISOString();
  const oneShot: Pipeline = {
    id: `convert-${String(Date.now())}`,
    name: '技能转换',
    description: `soft convert /${command.name}`,
    createdAt: now,
    updatedAt: now,
    onError: 'stop',
    steps: [
      {
        id: 's1',
        name: '转换',
        type: 'prompt',
        prompt: buildSoftConvertPrompt(command),
      },
    ],
  };
  const run = engine.start(oneShot, '', {});
  const deadline = Date.now() + timeoutMs;
  let record: PipelineRunRecord | undefined;
  for (;;) {
    await new Promise((resolve) => {
      setTimeout(resolve, SOFT_CONVERT_POLL_MS);
    });
    record = engine.getRun(run.runId);
    if (record === undefined) {
      break;
    }
    if (record.status !== 'running' && record.status !== 'idle') {
      break;
    }
    if (Date.now() > deadline) {
      engine.abort(run.runId);
      throw new Error('软转换超时：agent 未在 3 分钟内生成定义');
    }
  }
  const step = record?.steps[0];
  const output = step?.output ?? '';
  const pipeline = parseAgentPipelineOutput(output);
  if (pipeline === null) {
    const reason = step?.status === 'failed' ? `（步骤失败：${step.error ?? '未知错误'}）` : '';
    throw new Error(`软转换失败：agent 输出不是合法工程流 JSON${reason}`);
  }
  return pipeline;
}
