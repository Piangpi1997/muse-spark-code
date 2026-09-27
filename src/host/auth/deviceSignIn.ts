// Muse Code's captured experimental account/device-code flow (M55). This
// process owns no chat session and is always closed after success, cancel,
// timeout or error. The extension never sends its Model API key to this host.

import { spawnMspConnection, type Connection } from '@muse-code/sdk'
import * as z from 'zod/mini'
import { withDeadline } from '../../core/timeouts'
import {
  CREDENTIAL_POLL_INTERVAL_MS,
  CREDENTIAL_POLL_TIMEOUT_MS,
  MSP_CLIENT_NAME,
  MSP_HANDSHAKE_TIMEOUT_MS,
  MUSE_ACCOUNT_DEVICE_CODE_TYPE,
  MUSE_ACCOUNT_LOGIN_CANCEL,
  MUSE_ACCOUNT_LOGIN_COMPLETED,
  MUSE_ACCOUNT_LOGIN_START,
  MUSE_DEVICE_SIGN_IN_URL_ORIGIN,
} from '../../shared/constants'
import type { MuseCodeBackendManager } from '../backend/museCodeBackendManager'
import type { Logger } from '../logger'

const loginStartSchema = z.object({
  verificationUrl: z.url(),
  userCode: z.string().check(z.minLength(1)),
})
const loginCompletedSchema = z.object({ outcome: z.string() })
const loginCancelSchema = z.object({ cancelled: z.boolean() })

export interface DeviceSession {
  readonly connection: Pick<Connection, 'request' | 'onNotification'>
  readonly close: () => Promise<unknown>
}

export interface DeviceSignInDeps {
  readonly connect: (signal: AbortSignal) => Promise<DeviceSession>
  readonly credentialFileModifiedAt: () => number | undefined
  readonly sleep: (ms: number) => Promise<void>
  readonly now: () => number
  readonly signal: AbortSignal
  readonly onCode: (url: string, code: string) => void
}

export type DeviceSignInOutcome = 'signedIn' | 'cancelled' | 'timedOut'
const CANCELLED_START = Symbol('cancelled device sign-in start')
const CANCELLED_CONNECT = Symbol('cancelled device sign-in connection')

/** The returned URL is data from a CLI process: do not open arbitrary origins. */
export function parseDeviceCode(raw: unknown): { readonly url: string; readonly code: string } {
  const parsed = loginStartSchema.parse(raw)
  const url = new URL(parsed.verificationUrl)
  if (url.origin !== MUSE_DEVICE_SIGN_IN_URL_ORIGIN) {
    throw new Error('Muse Code returned an unexpected sign-in URL')
  }
  return { url: url.href, code: parsed.userCode }
}

export async function runDeviceSignIn(deps: DeviceSignInDeps): Promise<DeviceSignInOutcome> {
  const isAborted = () => deps.signal.aborted
  if (isAborted()) {
    return 'cancelled'
  }
  const before = deps.credentialFileModifiedAt()
  let session: DeviceSession
  try {
    session = await deps.connect(deps.signal)
  } catch (error: unknown) {
    if (isAborted()) {
      return 'cancelled'
    }
    throw error
  }
  const state: { isCancelledByHost: boolean } = { isCancelledByHost: false }
  try {
    session.connection.onNotification((notification) => {
      if (notification.method !== MUSE_ACCOUNT_LOGIN_COMPLETED) {
        return
      }
      const result = loginCompletedSchema.safeParse(notification.params)
      if (result.success && result.data.outcome === 'cancelled') {
        state.isCancelledByHost = true
      }
    })
    if (isAborted()) {
      return 'cancelled'
    }
    const cancelledStart = Promise.withResolvers<typeof CANCELLED_START>()
    const onAbort = () => {
      cancelledStart.resolve(CANCELLED_START)
    }
    deps.signal.addEventListener('abort', onAbort, { once: true })
    let start: unknown
    try {
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
    while (deps.now() < deadline) {
      const current = deps.credentialFileModifiedAt()
      if (current !== undefined && current !== before) {
        return 'signedIn'
      }
      if (state.isCancelledByHost) {
        return 'cancelled'
      }
      if (isAborted()) {
        await cancelLogin()
        return 'cancelled'
      }
      await deps.sleep(CREDENTIAL_POLL_INTERVAL_MS)
    }
    const current = deps.credentialFileModifiedAt()
    if (current !== undefined && current !== before) {
      return 'signedIn'
    }
    if (state.isCancelledByHost) {
      return 'cancelled'
    }
    await cancelLogin()
    return isAborted() ? 'cancelled' : 'timedOut'
  } finally {
    await session.close()
  }
}

/** Start a dedicated experimental MSP process. Keep it separate from chat. */
export async function connectDeviceSession(
  backend: MuseCodeBackendManager,
  extensionVersion: string,
  log: Logger,
  workspaceRoot: string | undefined,
  signal: AbortSignal,
): Promise<DeviceSession> {
  const isAborted = () => signal.aborted
  if (isAborted()) {
    throw new Error('Muse Code sign-in was cancelled')
  }
  backend.invalidateLaunch()
  const resolution = backend.resolveLaunch()
  if (!resolution.ok) {
    throw new Error(resolution.reason)
  }
  let isStderrReported = false
  const handshake = spawnMspConnection({
    command: resolution.launch.command,
    args: resolution.launch.args,
    ...(workspaceRoot !== undefined && { cwd: workspaceRoot }),
    env: backend.childEnvironment(),
    onStderr: () => {
      if (isStderrReported) {
        return
      }

      log.warn('Muse Code sign-in host wrote to stderr')
      isStderrReported = true
    },
  })
  const cancelledConnect = Promise.withResolvers<typeof CANCELLED_CONNECT>()
  const onAbort = () => {
    cancelledConnect.resolve(CANCELLED_CONNECT)
  }
  signal.addEventListener('abort', onAbort, { once: true })
  if (isAborted()) {
    onAbort()
  }
  try {
    const spawned = await Promise.race([
      withDeadline(
        handshake.initialize({
          clientInfo: { name: MSP_CLIENT_NAME, version: extensionVersion },
          capabilities: { experimentalApi: true, userInputDialogs: false },
        }),
        MSP_HANDSHAKE_TIMEOUT_MS,
        'Muse Code did not start sign-in host in time',
      ),
      cancelledConnect.promise,
    ])
    if (spawned === CANCELLED_CONNECT || isAborted()) {
      throw new Error('Muse Code sign-in was cancelled')
    }
    if (!spawned.initializeResult.experimentalApi) {
      throw new Error('This Muse Code version does not offer in-panel sign-in')
    }
    return { connection: spawned.connection, close: () => spawned.close() }
  } catch (error: unknown) {
    await handshake.close()
    throw error
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
