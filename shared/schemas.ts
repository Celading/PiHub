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

export const contentSchema = z.union([z.string(), z.array(contentBlockSchema)]);

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
    content: z.array(contentBlockSchema),
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
    content: z.array(contentBlockSchema),
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
  

/** Any streamed RPC event line: must parse as JSON with a string `type`. */
export const rpcStreamEventSchema = z
  .object({
    type: z.string(),
  })
  

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
