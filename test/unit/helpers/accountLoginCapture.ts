// Muse Code 1.4.0-R4302.1's device sign-in as captured live on 2026-09-27 in
// a throwaway home (test/fixtures/msp/account-login-*.json;
// docs/certification/sign-in-detection.md, "Live capture"; 0 model
// attempts). The unit tests and the fake CLI (test/e2e/fake-muse/serve.mjs)
// replay these frames, not guesses (AGENTS.md rule 13). The user code is its
// shape, AAAA-AAAA.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NotificationHandler } from '@muse-code/sdk'
import * as z from 'zod/mini'

/** The folder the fake CLI reads the captures from (MUSE_FAKE_CAPTURES). */
export const CAPTURES_FOLDER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'msp',
)

const captureSchema = z.object({
  frames: z.array(
    z.object({
      atMs: z.number(),
      dir: z.enum(['in', 'out']),
      frame: z.object({
        jsonrpc: z.literal('2.0'),
        id: z.optional(z.number()),
        method: z.optional(z.string()),
        params: z.optional(z.record(z.string(), z.unknown())),
        result: z.optional(z.record(z.string(), z.unknown())),
        emittedAtMs: z.optional(z.number()),
      }),
    }),
  ),
})

type CaptureName = 'expired' | 'cancelled'
type CapturedNotification = Parameters<NotificationHandler>[0]

function framesOf(name: CaptureName) {
  const file = path.join(CAPTURES_FOLDER, `account-login-${name}.json`)
  return captureSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).frames
}

/** What the captured host answered the first time it was asked `method`. */
function answerOf(name: CaptureName, method: string): Record<string, unknown> {
  const frames = framesOf(name)
  const asked = frames.find((entry) => entry.dir === 'out' && entry.frame.method === method)
  const result = frames.find((entry) => entry.dir === 'in' && entry.frame.id === asked?.frame.id)
    ?.frame.result
  if (result === undefined) {
    throw new Error(`the ${name} capture has no answer to ${method}`)
  }
  return result
}

/** The captured `account/loginCompleted` frame, as it arrived. */
function endingOf(name: CaptureName): CapturedNotification {
  const frame = framesOf(name).find(
    (entry) => entry.dir === 'in' && entry.frame.method === 'account/loginCompleted',
  )?.frame
  if (frame?.method === undefined) {
    throw new Error(`the ${name} capture has no account/loginCompleted`)
  }
  return {
    jsonrpc: frame.jsonrpc,
    method: frame.method,
    ...(frame.params !== undefined && { params: frame.params }),
    ...(frame.emittedAtMs !== undefined && { emittedAtMs: frame.emittedAtMs }),
  }
}

/** How long a code lived: from loginStart's answer to the `expired` ending (600.5 s). */
function codeLifetimeMs(): number {
  const frames = framesOf('expired')
  const started = frames.find((entry) => entry.frame.result?.['userCode'] !== undefined)
  const ended = frames.find((entry) => entry.frame.method === 'account/loginCompleted')
  if (started === undefined || ended === undefined) {
    throw new Error('the expired capture has no loginStart answer or no ending')
  }
  return ended.atMs - started.atMs
}

export const CAPTURED_CODE_LIFETIME_MS = codeLifetimeMs()
/** `account/loginStart {type: "deviceCode"}`: `{verificationUrl, userCode}`. */
export const CAPTURED_LOGIN_START = answerOf('cancelled', 'account/loginStart')
/** `account/read` with nothing stored: `{state: "loggedOut", credentialRequired: true}`. */
export const CAPTURED_LOGGED_OUT = answerOf('expired', 'account/read')
/** 600 s after loginStart: `{outcome: "expired", message: "login failed: the request expired"}`. */
export const CAPTURED_EXPIRED_ENDING = endingOf('expired')
/** Sent before the loginCancel answer: `{outcome: "cancelled"}`, no message. */
export const CAPTURED_CANCELLED_ENDING = endingOf('cancelled')
/** `account/loginCancel` with a flow pending: `{cancelled: true}`. */
export const CAPTURED_CANCEL_ANSWER = answerOf('cancelled', 'account/loginCancel')
/** `account/loginCancel` after the flow ended: `{cancelled: false}`. */
export const CAPTURED_CANCEL_AFTER_ENDING = answerOf('expired', 'account/loginCancel')

/**
 * The captured ending frame carrying a word no capture covers (`denied`,
 * `failed`, a future one): as the `cancelled` capture, the outcome alone.
 */
export function endingNamed(outcome: string): CapturedNotification {
  return { ...CAPTURED_CANCELLED_ENDING, params: { outcome } }
}
