// Muse Code's captured experimental account/device-code flow (M55). This
// process owns no chat session and is always closed after success, cancel,
// timeout or error. The extension never sends its Model API key to this host.
//
// A sign-in has succeeded (PLAN.md D26, 2026-09-27) when the host says so and
// `account/read` agrees, or when polling `account/read` on the same host sees
// the account sign in, or when the credential file is written and
// `account/read` does not contradict it; a CLI without `account/read` falls
// back to the host's word or the file alone. `account/loginCompleted` ends a
// denied, expired or failed flow at once. `account/changed` is not relied on:
// it did not fire for a change made outside the host.

import * as z from 'zod/mini'
import { clipForLog } from '../../core/logging'
import { withDeadline } from '../../core/timeouts'
import {
  CREDENTIAL_POLL_INTERVAL_MS,
  CREDENTIAL_POLL_TIMEOUT_MS,
  MSP_HANDSHAKE_TIMEOUT_MS,
  MUSE_ACCOUNT_DEVICE_CODE_TYPE,
  MUSE_ACCOUNT_LOGIN_CANCEL,
  MUSE_ACCOUNT_LOGIN_COMPLETED,
  MUSE_ACCOUNT_LOGIN_START,
  MUSE_ACCOUNT_STATES,
  MUSE_DEVICE_SIGN_IN_URL_ORIGIN,
  MUSE_LOGIN_OUTCOMES,
} from '../../shared/constants'
import type { Logger } from '../logger'
import { type AccountSession, type AccountState, readAccountState } from './accountHost'

const loginStartSchema = z.object({
  verificationUrl: z.url(),
  userCode: z.string().check(z.minLength(1)),
})
// `message` is display text for denied, expired and failed (the schema's
// `AccountLoginCompletedParams`); it goes to the log, clipped, never the panel.
const loginCompletedSchema = z.object({
  outcome: z.string(),
  message: z.optional(z.string()),
})
const loginCancelSchema = z.object({ cancelled: z.boolean() })

export interface DeviceSignInDeps {
  readonly connect: (signal: AbortSignal) => Promise<AccountSession>
  readonly credentialFileModifiedAt: () => number | undefined
  readonly sleep: (ms: number) => Promise<void>
  readonly now: () => number
  readonly signal: AbortSignal
  readonly onCode: (url: string, code: string) => void
  readonly log: Logger
}

/** How the flow ended the host's way: refused in the browser, too late, or not saved. */
export type DeviceSignInRefusal = 'denied' | 'expired' | 'failed'
export type DeviceSignInOutcome = 'signedIn' | 'cancelled' | 'timedOut' | DeviceSignInRefusal
const CANCELLED_START = Symbol('cancelled device sign-in start')

const ENDING_OUTCOMES: ReadonlyMap<string, DeviceSignInRefusal | 'cancelled'> = new Map([
  [MUSE_LOGIN_OUTCOMES.cancelled, 'cancelled'],
  [MUSE_LOGIN_OUTCOMES.denied, 'denied'],
  [MUSE_LOGIN_OUTCOMES.expired, 'expired'],
  [MUSE_LOGIN_OUTCOMES.failed, 'failed'],
])

/** The returned URL is data from a CLI process: do not open arbitrary origins. */
export function parseDeviceCode(raw: unknown): { readonly url: string; readonly code: string } {
  const parsed = loginStartSchema.parse(raw)
  const url = new URL(parsed.verificationUrl)
  if (url.origin !== MUSE_DEVICE_SIGN_IN_URL_ORIGIN) {
    throw new Error('Muse Code returned an unexpected sign-in URL')
  }
  return { url: url.href, code: parsed.userCode }
}

/** What the host said when the flow ended; the first ending counts. */
interface HostEnding {
  outcome: string | undefined
}

/** The signals that a new sign-in landed, as one poll sees them. */
interface SignInSignals {
  readonly initial: AccountState | undefined
  readonly current: AccountState | undefined
  readonly isGranted: boolean
  readonly isFileWritten: boolean
}

function isSignedIn(signals: SignInSignals): boolean {
  const { initial, current, isGranted, isFileWritten } = signals
  if (current === undefined) {
    // A CLI without `account/read`: the host's word, or a new file.
    return isGranted || isFileWritten
  }
  // A file written by a sign-out, or a "granted" the store does not show yet.
  if (current.state === MUSE_ACCOUNT_STATES.loggedOut && current.credentialRequired) {
    return false
  }
  // `envKey` or a stored key may mask the new login, so the host's word and
  // a new file count while the account is anything but signed out.
  const hasSignedIn =
    current.state === MUSE_ACCOUNT_STATES.accountLogin &&
    initial?.state !== MUSE_ACCOUNT_STATES.accountLogin
  return isGranted || isFileWritten || hasSignedIn
}

export async function runDeviceSignIn(deps: DeviceSignInDeps): Promise<DeviceSignInOutcome> {
  const isAborted = () => deps.signal.aborted
  if (isAborted()) {
    return 'cancelled'
  }
  const before = deps.credentialFileModifiedAt()
  let session: AccountSession
  try {
    session = await deps.connect(deps.signal)
  } catch (error: unknown) {
    if (isAborted()) {
      return 'cancelled'
    }
    throw error
  }
  const ending: HostEnding = { outcome: undefined }
  try {
    session.connection.onNotification((notification) => {
      if (notification.method !== MUSE_ACCOUNT_LOGIN_COMPLETED || ending.outcome !== undefined) {
        return
      }
      const result = loginCompletedSchema.safeParse(notification.params)
      if (!result.success) {
        return
      }
      ending.outcome = result.data.outcome
      const message =
        result.data.message === undefined ? '' : `: ${clipForLog(result.data.message)}`
      deps.log.info(`Muse Code sign-in ended: ${result.data.outcome}${message}`)
    })
    if (isAborted()) {
      return 'cancelled'
    }
    const cancelledStart = Promise.withResolvers<typeof CANCELLED_START>()
    const onAbort = () => {
      cancelledStart.resolve(CANCELLED_START)
    }
    deps.signal.addEventListener('abort', onAbort, { once: true })
    let initial: AccountState | undefined
    let start: unknown
    try {
      // The account before the flow, so a sign-in shows as a change.
      const read = await Promise.race([
        readAccountState(session.connection),
        cancelledStart.promise,
      ])
      if (read === CANCELLED_START) {
        return 'cancelled'
      }
      initial = read
      start = await Promise.race([
        withDeadline(
          session.connection.request(MUSE_ACCOUNT_LOGIN_START, {
            type: MUSE_ACCOUNT_DEVICE_CODE_TYPE,
          }),
          MSP_HANDSHAKE_TIMEOUT_MS,
          'Muse Code did not start sign-in in time',
        ),
        cancelledStart.promise,
      ])
    } finally {
      deps.signal.removeEventListener('abort', onAbort)
    }
    if (start === CANCELLED_START) {
      return 'cancelled'
    }
    const { url, code } = parseDeviceCode(start)
    deps.onCode(url, code)
    const deadline = deps.now() + CREDENTIAL_POLL_TIMEOUT_MS
    const cancelLogin = async () => {
      loginCancelSchema.parse(
        await withDeadline(
          session.connection.request(MUSE_ACCOUNT_LOGIN_CANCEL, {}),
          MSP_HANDSHAKE_TIMEOUT_MS,
          'Muse Code did not cancel sign-in in time',
        ),
      )
    }
    const hasLanded = async () => {
      const modified = deps.credentialFileModifiedAt()
      return isSignedIn({
        initial,
        current: await readAccountState(session.connection),
        isGranted: ending.outcome === MUSE_LOGIN_OUTCOMES.granted,
        isFileWritten: modified !== undefined && modified !== before,
      })
    }
    const hostEnding = () =>
      ending.outcome === undefined ? undefined : ENDING_OUTCOMES.get(ending.outcome)
    while (deps.now() < deadline) {
      if (await hasLanded()) {
        return 'signedIn'
      }
      const ended = hostEnding()
      if (ended !== undefined) {
        return ended
      }
      if (isAborted()) {
        await cancelLogin()
        return 'cancelled'
      }
      await deps.sleep(CREDENTIAL_POLL_INTERVAL_MS)
    }
    if (await hasLanded()) {
      return 'signedIn'
    }
    const ended = hostEnding()
    if (ended !== undefined) {
      return ended
    }
    await cancelLogin()
    return isAborted() ? 'cancelled' : 'timedOut'
  } finally {
    await session.close()
  }
}
