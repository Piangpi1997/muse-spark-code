// Muse Code's experimental account methods on a short-lived `muse serve`
// that owns no conversation (M55; PLAN.md D26, 2026-09-27): the device
// sign-in, `account/read` (which credential the CLI would use) and
// `account/logout`. The chat host is not started with `experimentalApi`, so
// these always get a process of their own, closed when they finish. The
// extension never sends its Model API key to it, and never keeps, logs or
// shows the account's `label` (an e-mail address) or `avatarUrl`.

import { spawnMspConnection, type Connection } from '@muse-code/sdk'
import * as z from 'zod/mini'
import { withDeadline } from '../../core/timeouts'
import {
  MSP_CLIENT_NAME,
  MSP_HANDSHAKE_TIMEOUT_MS,
  MUSE_ACCOUNT_LOGOUT,
  MUSE_ACCOUNT_READ,
  MUSE_ACCOUNT_STATES,
} from '../../shared/constants'
import type { MuseCodeBackendManager } from '../backend/museCodeBackendManager'
import type { Logger } from '../logger'

// `AccountState` as captured (1.3.0 and 1.4.0): `label` and `avatarUrl` are
// not in the schema, so parsing drops them.
const accountStateSchema = z.object({
  state: z.string(),
  credentialRequired: z.boolean(),
})

export type AccountState = z.infer<typeof accountStateSchema>

export interface AccountSession {
  readonly connection: Pick<Connection, 'request' | 'onNotification'>
  readonly close: () => Promise<unknown>
}

const CANCELLED_CONNECT = Symbol('cancelled account host connection')

/** The error's name only: a CLI message can carry a path or an account. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error'
}

/** Whether a stored credential (a sign-in or a key the CLI saved) is the one in use. */
export function isStoredSignIn(account: AccountState): boolean {
  return (
    account.state === MUSE_ACCOUNT_STATES.accountLogin ||
    account.state === MUSE_ACCOUNT_STATES.apiKey
  )
}

type AccountConnection = AccountSession['connection']

/** An account method's `AccountState` answer; undefined when it failed or came in another shape. */
async function requestAccount(
  connection: AccountConnection,
  method: string,
): Promise<AccountState | undefined> {
  try {
    const result = accountStateSchema.safeParse(
      await withDeadline(
        connection.request(method, {}),
        MSP_HANDSHAKE_TIMEOUT_MS,
        `Muse Code did not answer ${method} in time`,
      ),
    )
    return result.success ? result.data : undefined
  } catch {
    return undefined
  }
}

/** `account/read` on an open host; undefined when the host cannot say. */
export async function readAccountState(
  connection: AccountConnection,
): Promise<AccountState | undefined> {
  return await requestAccount(connection, MUSE_ACCOUNT_READ)
}

/** `use` on one short-lived host, closed afterwards; `fallback` when it cannot start. */
async function onAccountHost<T>(
  connect: () => Promise<AccountSession>,
  log: Logger,
  fallback: T,
  use: (connection: AccountConnection) => Promise<T>,
): Promise<T> {
  let session: AccountSession
  try {
    session = await connect()
  } catch (error: unknown) {
    log.warn(`The Muse Code account host could not start: ${errorName(error)}`)
    return fallback
  }
  try {
    return await use(session.connection)
  } finally {
    try {
      await session.close()
    } catch (error: unknown) {
      log.warn(`The Muse Code account host did not close cleanly: ${errorName(error)}`)
    }
  }
}

/** One short-lived host asked `account/read`; undefined when it could not start or say. */
export async function probeAccount(
  connect: () => Promise<AccountSession>,
  log: Logger,
): Promise<AccountState | undefined> {
  return await onAccountHost(connect, log, undefined, readAccountState)
}

/**
 * MSP `account/logout` on a short-lived host, confirmed by `account/read`:
 * `confirmed` when no stored credential is in use afterwards (`META_API_KEY`,
 * which no logout can unset, is the caller's to report); `unconfirmed` when
 * the host could not start, refused, or still reports a stored credential.
 */
export async function logOutAccount(
  connect: () => Promise<AccountSession>,
  log: Logger,
): Promise<'confirmed' | 'unconfirmed'> {
  return await onAccountHost<'confirmed' | 'unconfirmed'>(
    connect,
    log,
    'unconfirmed',
    async (connection) => {
      const answer = await requestAccount(connection, MUSE_ACCOUNT_LOGOUT)
      const after = answer === undefined ? undefined : await readAccountState(connection)
      if (after === undefined || isStoredSignIn(after)) {
        log.warn(`Muse Code did not confirm account/logout (${after?.state ?? 'no answer'})`)
        return 'unconfirmed'
      }
      log.info(`Muse Code signed out through account/logout (now ${after.state})`)
      return 'confirmed'
    },
  )
}

/** Start a dedicated experimental MSP process. Keep it separate from chat. */
export async function connectAccountSession(
  backend: MuseCodeBackendManager,
  extensionVersion: string,
  log: Logger,
  workspaceRoot: string | undefined,
  signal: AbortSignal,
): Promise<AccountSession> {
  const isAborted = () => signal.aborted
  if (isAborted()) {
    throw new Error('The Muse Code account host was cancelled')
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

      log.warn('The Muse Code account host wrote to stderr')
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
        'The Muse Code account host did not start in time',
      ),
      cancelledConnect.promise,
    ])
    if (spawned === CANCELLED_CONNECT || isAborted()) {
      throw new Error('The Muse Code account host was cancelled')
    }
    if (!spawned.initializeResult.experimentalApi) {
      throw new Error('This Muse Code version does not offer its account methods')
    }
    return { connection: spawned.connection, close: () => spawned.close() }
  } catch (error: unknown) {
    await handshake.close()
    throw error
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
