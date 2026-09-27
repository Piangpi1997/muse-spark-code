// The extension's Model API scheduled prompt, shared by the host, webview and
// persistent workspace store (PLAN.md M52). Muse Code's native cron jobs do
// not use this shape; MSP has no scheduler contract.

import * as z from 'zod/mini'

export const scheduleCadenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('interval'), everyMs: z.number() }),
  z.object({ kind: z.literal('cron'), expression: z.string() }),
])
export type ScheduleCadence = z.infer<typeof scheduleCadenceSchema>

export const scheduledPromptSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  workspaceRoot: z.string(),
  accountId: z.string(),
  prompt: z.string(),
  cadence: scheduleCadenceSchema,
  createdAtMs: z.number(),
  expiresAtMs: z.number(),
  nextFireAtMs: z.number(),
  fireCount: z.number(),
  lastFireAtMs: z.optional(z.number()),
})
export type ScheduledPrompt = z.infer<typeof scheduledPromptSchema>

/** The prompt, model and session the user accepted for one due occurrence. */
export interface ScheduleRunConfirmation {
  readonly sessionId: string
  readonly modelId: string
  readonly prompt: string
}

/** Safe panel projection: key identity and workspace path stay in the host. */
export const scheduleViewSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  cadence: scheduleCadenceSchema,
  nextFireAtMs: z.number(),
  fireCount: z.number(),
  lastFireAtMs: z.optional(z.number()),
})
export type ScheduleView = z.infer<typeof scheduleViewSchema>

export function scheduleViewOf(job: ScheduledPrompt): ScheduleView {
  return {
    id: job.id,
    prompt: job.prompt,
    cadence: job.cadence,
    nextFireAtMs: job.nextFireAtMs,
    fireCount: job.fireCount,
    ...(job.lastFireAtMs !== undefined && { lastFireAtMs: job.lastFireAtMs }),
  }
}

export interface ScheduleStore {
  create(job: ScheduledPrompt): Promise<void>
  list(sessionId: string): Promise<readonly ScheduledPrompt[]>
  remove(sessionId: string, jobId: string): Promise<boolean>
  /** Atomic, durable receipt. False means this occurrence was already admitted. */
  claim(job: ScheduledPrompt, occurrenceMs: number): Promise<boolean>
}
