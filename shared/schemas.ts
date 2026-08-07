import { z } from 'zod';

/* Boundary schemas: validate untrusted pi protocol payloads and the panel's
 * own API contract. Unknown keys are stripped; output types stay precise. */

export const costBreakdownSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  total: z.number(),
});

export const tokenUsageSchema = z
  .object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    totalTokens: z.number().optional(),
    cost: costBreakdownSchema.optional(),
  })
  

export const attachmentSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    fileName: z.string().optional(),
    mimeType: z.string().optional(),
    size: z.number().optional(),
    content: z.string().optional(),
  })
  

export const textContentSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

export const thinkingContentSchema = z
  .object({
    type: z.literal('thinking'),
    thinking: z.string(),
    thinkingSignature: z.string().optional(),
  })
  

export const toolCallContentSchema = z
  .object({
    type: z.literal('toolCall'),
    id: z.string(),
    name: z.string(),
    arguments: z.unknown(),
  })
  

export const imageContentSchema = z
  .object({
    type: z.literal('image'),
    data: z.string().optional(),
    mimeType: z.string().optional(),
    url: z.string().optional(),
  })
  

export const contentBlockSchema = z.discriminatedUnion('type', [
  textContentSchema,
  thinkingContentSchema,
  toolCallContentSchema,
  imageContentSchema,
]);

/**
 * Assistant/user content blocks. Provider extensions (e.g. Volcengine
 * reasoning_content or future block types) must not kill the whole message:
 * unknown blocks are preserved as generic objects and skipped by the UI
 * renderer (ContentBlocks switch has no match → renders nothing).
 */
export const contentSchema = z.union([
  z.string(),
  z.array(z.union([contentBlockSchema, z.record(z.string(), z.unknown())])),
]);

export const userMessageSchema = z
  .object({
    role: z.literal('user'),
    content: contentSchema,
    attachments: z.array(attachmentSchema).optional(),
    timestamp: z.number(),
  })
  

export const assistantMessageSchema = z
  .object({
    role: z.literal('assistant'),
    content: z.array(z.union([contentBlockSchema, z.record(z.string(), z.unknown())])),
    api: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    usage: tokenUsageSchema.optional(),
    stopReason: z.string().optional(),
    timestamp: z.number(),
  })
  

export const toolResultMessageSchema = z
  .object({
    role: z.literal('toolResult'),
    toolCallId: z.string(),
    toolName: z.string(),
    content: z.array(z.union([contentBlockSchema, z.record(z.string(), z.unknown())])),
    usage: tokenUsageSchema.optional(),
    isError: z.boolean().default(false),
    timestamp: z.number(),
  })
  

export const bashExecutionMessageSchema = z
  .object({
    role: z.literal('bashExecution'),
    command: z.string(),
    output: z.string(),
    exitCode: z.number(),
    cancelled: z.boolean(),
    truncated: z.boolean(),
    fullOutputPath: z.string().nullable(),
    timestamp: z.number(),
  })
  

export const agentMessageSchema = z.discriminatedUnion('role', [
  userMessageSchema,
  assistantMessageSchema,
  toolResultMessageSchema,
  bashExecutionMessageSchema,
]);

export const sessionHeaderEventSchema = z
  .object({
    type: z.literal('session'),
    version: z.number(),
    id: z.string(),
    timestamp: z.string(),
    cwd: z.string(),
    name: z.string().optional(),
  })

export const sessionInfoEventSchema = z
  .object({
    type: z.literal('session_info'),
    id: z.string(),
    parentId: z.string().nullable(),
    timestamp: z.string(),
    name: z.string(),
  })
  

export const messageEventSchema = z
  .object({
    type: z.literal('message'),
    id: z.string(),
    parentId: z.string().nullable(),
    timestamp: z.string(),
    message: agentMessageSchema,
  })
  

export const thinkingLevelChangeEventSchema = z
  .object({
    type: z.literal('thinking_level_change'),
    id: z.string(),
    parentId: z.string().nullable(),
    timestamp: z.string(),
    thinkingLevel: z.string(),
  })
  

export const modelChangeEventSchema = z
  .object({
    type: z.literal('model_change'),
    id: z.string(),
    parentId: z.string().nullable(),
    timestamp: z.string(),
    provider: z.string(),
    modelId: z.string(),
  })
  

/**
 * Session JSONL line schema: strict discriminated union over the known kinds.
 * Unknown kinds (labels, future events) are rejected and skipped by the
 * parser; they carry no panel data.
 */
export const sessionEventSchema = z.discriminatedUnion('type', [
  sessionHeaderEventSchema,
  sessionInfoEventSchema,
  messageEventSchema,
  thinkingLevelChangeEventSchema,
  modelChangeEventSchema,
]);

export const modelInfoSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    api: z.string(),
    provider: z.string(),
    baseUrl: z.string().optional(),
    reasoning: z.boolean().optional(),
    input: z.array(z.string()).optional(),
    contextWindow: z.number().optional(),
    maxTokens: z.number().optional(),
    cost: costBreakdownSchema.optional(),
  })
  

export const rpcResponseSchema = z
  .object({
    type: z.literal('response'),
    id: z.string().optional(),
    command: z.string(),
    success: z.boolean(),
    data: z.unknown().optional(),
    error: z.string().optional(),
  })
  

/**
 * Any streamed RPC event line: must parse as JSON with a string `type`.
 * `.loose()` keeps protocol fields (message, assistantMessageEvent, …)
 * intact — the frame is forwarded verbatim to consumers; only the `type`
 * shape is validated. Stripping would silently drop streaming content.
 */
export const rpcStreamEventSchema = z
  .object({
    type: z.string(),
  })
  .loose()

/** Extension UI request frame (pi v0.83.0 rpc-types: extension_ui_request). */
export const extensionUiRequestSchema = z
  .discriminatedUnion('method', [
    z.object({
      type: z.literal('extension_ui_request'),
      id: z.string(),
      method: z.literal('select'),
      title: z.string(),
      options: z.array(z.string()),
      timeout: z.number().optional(),
    }),
    z.object({
      type: z.literal('extension_ui_request'),
      id: z.string(),
      method: z.literal('confirm'),
      title: z.string(),
      message: z.string(),
      timeout: z.number().optional(),
    }),
    z.object({
      type: z.literal('extension_ui_request'),
      id: z.string(),
      method: z.literal('input'),
      title: z.string(),
      placeholder: z.string().optional(),
      timeout: z.number().optional(),
    }),
    z.object({
      type: z.literal('extension_ui_request'),
      id: z.string(),
      method: z.literal('editor'),
      title: z.string(),
      prefill: z.string().optional(),
    }),
    z.object({
      type: z.literal('extension_ui_request'),
      id: z.string(),
      method: z.literal('notify'),
      message: z.string(),
      notifyType: z.enum(['info', 'warning', 'error']).optional(),
    }),
    z.object({
      type: z.literal('extension_ui_request'),
      id: z.string(),
      method: z.literal('setStatus'),
      statusKey: z.string(),
      statusText: z.string().optional(),
    }),
    z.object({
      type: z.literal('extension_ui_request'),
      id: z.string(),
      method: z.literal('setWidget'),
      widgetKey: z.string(),
      widgetLines: z.array(z.string()).optional(),
      widgetPlacement: z.enum(['aboveEditor', 'belowEditor']).optional(),
    }),
    z.object({
      type: z.literal('extension_ui_request'),
      id: z.string(),
      method: z.literal('setTitle'),
      title: z.string(),
    }),
    z.object({
      type: z.literal('extension_ui_request'),
      id: z.string(),
      method: z.literal('set_editor_text'),
      text: z.string(),
    }),
  ])

export const settingsFileSchema = z
  .object({
    theme: z.string().optional(),
    defaultProvider: z.string().optional(),
    defaultModel: z.string().optional(),
    defaultThinkingLevel: z.string().optional(),
  })
  

export const modelStoreEntrySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    api: z.string(),
    baseUrl: z.string().optional(),
    provider: z.string(),
    reasoning: z.boolean().optional(),
    input: z.array(z.string()).optional(),
    cost: z
      .object({
        input: z.number(),
        output: z.number(),
        cacheRead: z.number(),
        cacheWrite: z.number(),
      })
      .optional(),
    contextWindow: z.number().optional(),
    maxTokens: z.number().optional(),
  })

export const modelStoreFileSchema = z.record(
  z.string(),
  z.object({
    models: z.array(modelStoreEntrySchema),
    checkedAt: z.number().optional(),
    lastModified: z.number().optional(),
    etag: z.string().optional(),
  }),
);

/** POST /api/rpc/ui-respond body (answer to an extension UI dialog). */
export const uiRespondBodySchema = z
  .object({
    id: z.string(),
    value: z.string().optional(),
    confirmed: z.boolean().optional(),
    cancelled: z.boolean().optional(),
  })

/* ---- pipelines (phase-3 P1-02-C, PiHub-exclusive orchestration) ----
 * The pi agent has no multi-step orchestration surface; a pipeline is a
 * PiHub-owned sequence of steps executed against one pi session. All step
 * types map to existing RPC primitives (prompt/steer/model/thinking) plus a
 * PiHub-only human-approval step. */

export const pipelineStepSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(['prompt', 'steer', 'approval', 'setModel', 'setThinking']),
  /** Template text for prompt/steer steps; supports {{var}} interpolation. */
  prompt: z.string().optional(),
  model: z
    .object({
      provider: z.string().min(1),
      id: z.string().min(1),
    })
    .optional(),
  thinkingLevel: z.string().optional(),
  streamingBehavior: z.enum(['normal', 'steer', 'followUp']).optional(),
  /** Ask the operator before executing this step (approval/confirmation). */
  requiresApproval: z.boolean().optional(),
  /** Output match (substring/regex tested against the last assistant text). */
  match: z.string().optional(),
  /** Step id to run next when match hits (branching). */
  nextOnMatch: z.string().optional(),
  /** Step id to run next when match misses. */
  nextOnMiss: z.string().optional(),
  /** Retry count for onError=retry. */
  maxRetries: z.number().int().min(0).optional(),
});

export const pipelineSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  steps: z.array(pipelineStepSchema).min(1),
  /** Error strategy for the whole run: stop (default), skip, or retry. */
  onError: z.enum(['stop', 'skip', 'retry']).default('stop'),
});

export const pipelineUpsertBodySchema = z.object({
  pipeline: pipelineSchema,
});

export const pipelineRunBodySchema = z.object({
  pipelineId: z.string().min(1),
  input: z.string().optional(),
});

export const pipelineApproveBodySchema = z.object({
  approve: z.boolean(),
});

/** POST /api/pipelines/convert/* body (skill → pipeline, P1-10 A). */
export const pipelineConvertBodySchema = z.object({
  commandName: z.string().min(1).max(256),
});
