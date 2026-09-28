// Muse Code's captured experimental account/device-code flow (M55). This
// process owns no chat session and is always closed after success, cancel,
// timeout or error. The extension never sends its Model API key to this host.
//
// A sign-in has succeeded (PLAN.md D26, 2026-09-27) when polling
// `account/read` on the same host sees the account sign in, or when the
// credential file is written and `account/read` does not contradict it; a
// CLI that cannot answer `account/read` falls back to the file alone.
//
// `account/loginCompleted` ends the flow on any outcome but `granted`. Only
// `cancelled` and `expired` were captured live (docs/certification/
// sign-in-detection.md, "Live capture"), so they are the only endings with a
// meaning of their own; any other word is shown as the CLI named it
// (AGENTS.md rule 13). `granted` was not captured, so it is not taken for a
// sign-in: `account/read` or the file decides. `account/changed` is not
// relied on: it fired neither for a change made outside the host nor for an
// expired code.
//
// Cancel and the host's ending are noticed at once, even while an
// `account/read` is unanswered, and the `account/loginCancel` sent on the way
// out is bounded: the host is closed either way, which ends its flow.

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
  MUSE_LOGIN_CANCEL_TIMEOUT_MS,
  MUSE_LOGIN_OUTCOME_SHOWN_MAX_CHARS,
  MUSE_LOGIN_OUTCOMES,
} from '../../shared/constants'
import type { Logger } from '../logger'
import { type AccountSession, type AccountState, readAccountState } from './accountHost'

const loginStartSchema = z.object({
  verificationUrl: z.url(),
  userCode: z.string().check(z.minLength(1)),
})
// As captured: `{outcome: "expired", message: "login failed: the request
// expired"}` and `{outcome: "cancelled"}`. The message goes to the log,
// clipped, never the panel.
const loginCompletedSchema = z.object({
  outcome: z.string().check(z.minLength(1)),
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

/** An ending Muse Code named that no capture covers: shown as it came (AGENTS.md rule 13). */
export interface DeviceSignInEnded {
  readonly endedAs: string
}
/** How the host ended a flow that did not sign in. */
type HostEnding = 'cancelled' | 'expired' | DeviceSignInEnded
export type DeviceSignInOutcome = 'signedIn' | 'timedOut' | HostEnding

const STOPPED = Symbol('device sign-in stopped')

// The endings captured live: `cancelled` (1.3.0, M55; 1.4.0-R4302.1) and
// `expired` (1.4.0-R4302.1, 600 s after `account/loginStart`).
const CAPTURED_ENDINGS: ReadonlyMap<string, 'cancelled' | 'expired'> = new Map([
  [MUSE_LOGIN_OUTCOMES.cancelled, 'cancelled'],
  [MUSE_LOGIN_OUTCOMES.expired, 'expired'],
])

/** How `outcome` ends the flow; undefined for `granted`, which `account/read` must bear out. */
function endingOf(outcome: string): HostEnding | undefined {
  if (outcome === MUSE_LOGIN_OUTCOMES.granted) {
    return undefined
  }
  const captured = CAPTURED_ENDINGS.get(outcome)
  if (captured !== undefined) {
    return captured
  }
  const shown =
    outcome.length > MUSE_LOGIN_OUTCOME_SHOWN_MAX_CHARS
      ? `${outcome.slice(0, MUSE_LOGIN_OUTCOME_SHOWN_MAX_CHARS)}…`
      : outcome
  return { endedAs: shown }
}

/** The returned URL is data from a CLI process: do not open arbitrary origins. */
export function parseDeviceCode(raw: unknown): { readonly url: string; readonly code: string } {
  const parsed = loginStartSchema.parse(raw)
  const url = new URL(parsed.verificationUrl)
  if (url.origin !== MUSE_DEVICE_SIGN_IN_URL_ORIGIN) {
    throw new Error('Muse Code returned an unexpected sign-in URL')
  }
  return { url: url.href, code: parsed.userCode }
}

/** The signals that a new sign-in landed, as one poll sees them. */
interface SignInSignals {
  readonly initial: AccountState | undefined
  /** Undefined when the host did not answer, or the poll was cut short. */
  readonly current: AccountState | undefined
  readonly isFileWritten: boolean
}

function isSignedIn(signals: SignInSignals): boolean {
  const { initial, current, isFileWritten } = signals
  if (current === undefined) {
    return isFileWritten
  }
  // A file written by a sign-out. Signed out is signed out, whatever the
  // uncaptured `credentialRequired: false` might mean (the review of PR #49).
  if (current.state === MUSE_ACCOUNT_STATES.loggedOut) {
    return false
  }
  // `envKey` or a stored key may mask the new login, so a new file counts
  // while the account is anything but signed out.
  const hasSignedIn =
    current.state === MUSE_ACCOUNT_STATES.accountLogin &&
    initial?.state !== MUSE_ACCOUNT_STATES.accountLogin
  return isFileWritten || hasSignedIn
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
  // Cancel, or the host's own ending: whatever the flow is waiting on stops.
  const stopped = Promise.withResolvers<typeof STOPPED>()
  const stop = () => {
    stopped.resolve(STOPPED)
  }
  let hostEnding: HostEnding | undefined
  let isEnded = false
  try {
    session.connection.onNotification((notification) => {
      if (isEnded || notification.method !== MUSE_ACCOUNT_LOGIN_COMPLETED) {
        return
      }
      const result = loginCompletedSchema.safeParse(notification.params)
      if (!result.success) {
        return
      }
      // The first ending counts; the host runs one flow.
      isEnded = true
      hostEnding = endingOf(result.data.outcome)
      const message =
        result.data.message === undefined ? '' : `: ${clipForLog(result.data.message)}`
      deps.log.info(`Muse Code sign-in ended: ${clipForLog(result.data.outcome)}${message}`)
      if (hostEnding !== undefined) {
        stop()
      }
    })
    deps.signal.addEventListener('abort', stop, { once: true })
    if (isAborted()) {
      return 'cancelled'
    }
    /** `work`, or STOPPED as soon as Cancel or the host's ending arrives. */
    const untilStopped = <T>(work: Promise<T>) => Promise.race([work, stopped.promise])
    // The account before the flow, so a sign-in shows as a change.
    const initial = await untilStopped(readAccountState(session.connection))
    if (initial === STOPPED) {
      return hostEnding ?? 'cancelled'
    }
    const start = await untilStopped(
      withDeadline(
        session.connection.request(MUSE_ACCOUNT_LOGIN_START, {
          type: MUSE_ACCOUNT_DEVICE_CODE_TYPE,
        }),
        MSP_HANDSHAKE_TIMEOUT_MS,
        'Muse Code did not start sign-in in time',
      ),
    )
    if (start === STOPPED) {
      return hostEnding ?? 'cancelled'
    }
    const { url, code } = parseDeviceCode(start)
    deps.onCode(url, code)
    const deadline = deps.now() + CREDENTIAL_POLL_TIMEOUT_MS
    // Captured: the ending arrives before this answer, in milliseconds. A
    // host that does not answer is closed all the same.
    const cancelLogin = async () => {
      try {
        loginCancelSchema.parse(
          await withDeadline(
            session.connection.request(MUSE_ACCOUNT_LOGIN_CANCEL, {}),
            MUSE_LOGIN_CANCEL_TIMEOUT_MS,
            'Muse Code did not cancel sign-in in time',
          ),
        )
      } catch {
        deps.log.warn('Muse Code did not confirm the sign-in cancel; closing its host')
      }
    }
    const hasLanded = async () => {
      const modified = deps.credentialFileModifiedAt()
      const current = await untilStopped(readAccountState(session.connection))
      // A stop (Cancel, an ending) decides the flow: a file change alone
      // must not turn it into a sign-in (the review of PR #49).
      if (current === STOPPED) {
        return false
      }
      return isSignedIn({
        initial,
        current,
        isFileWritten: modified !== undefined && modified !== before,
      })
    }
    while (deps.now() < deadline) {
      if (await hasLanded()) {
        return 'signedIn'
      }
      if (hostEnding !== undefined) {
        return hostEnding
      }
      if (isAborted()) {
        await cancelLogin()
        return 'cancelled'
      }
      await untilStopped(deps.sleep(CREDENTIAL_POLL_INTERVAL_MS))
    }
    if (await hasLanded()) {
      return 'signedIn'
    }
    if (hostEnding !== undefined) {
      return hostEnding
    }
    await cancelLogin()
    return isAborted() ? 'cancelled' : 'timedOut'
  } finally {
    deps.signal.removeEventListener('abort', stop)
    await session.close()
  }
}
