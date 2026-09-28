import { describe, expect, it, vi } from 'vitest'
import type { AccountSession } from '../../src/host/auth/accountHost'
import { CREDENTIAL_POLL_TIMEOUT_MS } from '../../src/shared/constants'
import { parseDeviceCode, runDeviceSignIn } from '../../src/host/auth/deviceSignIn'
import { FakeLogOutputChannel } from './helpers/fakes'

const DEVICE_URL = 'https://auth.meta.com/oauth/device/?code=example'
const log = new FakeLogOutputChannel()

// `account/read` as captured on 1.3.0 and 1.4.0 (the label redacted there,
// an e-mail address in real life, and dropped by the parser here).
const LOGGED_OUT = { state: 'loggedOut', credentialRequired: true }
const SIGNED_IN = { state: 'accountLogin', label: 'person@example.com', credentialRequired: true }

type AccountAnswer = Record<string, unknown> | undefined

/**
 * A sign-in host. `account` answers `account/read` (undefined: a CLI without
 * it, which refuses the method as unknown).
 */
function session(account: () => AccountAnswer = () => undefined) {
  const request = vi.fn((method: string) => {
    if (method === 'account/loginStart') {
      return Promise.resolve({ verificationUrl: DEVICE_URL, userCode: 'ABCD-EFGH' })
    }
    if (method === 'account/read') {
      const answer = account()
      return answer === undefined
        ? Promise.reject(new Error('no handler for account/read'))
        : Promise.resolve(answer)
    }
    return Promise.resolve({ cancelled: true })
  })
  const onNotification = vi.fn<AccountSession['connection']['onNotification']>()
  const close = vi.fn(() => Promise.resolve())
  const deviceSession: AccountSession = { connection: { request, onNotification }, close }
  const complete = (params: Record<string, unknown>) => {
    onNotification.mock.calls[0]?.[0]({
      jsonrpc: '2.0',
      method: 'account/loginCompleted',
      params,
    })
  }
  return { request, onNotification, close, deviceSession, complete }
}

describe('Muse Code device sign-in', () => {
  it('accepts the captured code shape only from Meta auth', () => {
    expect(parseDeviceCode({ verificationUrl: DEVICE_URL, userCode: 'ABCD-EFGH' })).toEqual({
      url: DEVICE_URL,
      code: 'ABCD-EFGH',
    })
    expect(() =>
      parseDeviceCode({ verificationUrl: 'https://example.com/', userCode: 'ABCD-EFGH' }),
    ).toThrow()
    expect(() => parseDeviceCode({ verificationUrl: DEVICE_URL })).toThrow()
  })

  it('shows the code, observes a new credential, and closes the temporary host', async () => {
    const t = session()
    let modified: number | undefined
    let clock = 0
    const onCode = vi.fn()
    await expect(
      runDeviceSignIn({
        connect: () => Promise.resolve(t.deviceSession),
        credentialFileModifiedAt: () => modified,
        sleep: () => {
          modified = 2
          return Promise.resolve()
        },
        now: () => {
          clock += 1000
          return clock
        },
        signal: new AbortController().signal,
        onCode,
        log,
      }),
    ).resolves.toBe('signedIn')
    expect(onCode).toHaveBeenCalledWith(DEVICE_URL, 'ABCD-EFGH')
    expect(t.request).toHaveBeenCalledWith('account/loginStart', { type: 'deviceCode' })
    expect(t.close).toHaveBeenCalledOnce()
  })

  it('sends loginCancel after user cancellation and closes the host', async () => {
    const t = session()
    const abort = new AbortController()
    await expect(
      runDeviceSignIn({
        connect: () => Promise.resolve(t.deviceSession),
        credentialFileModifiedAt: () => undefined,
        sleep: () => {
          abort.abort()
          return Promise.resolve()
        },
        now: () => 0,
        signal: abort.signal,
        onCode: vi.fn(),
        log,
      }),
    ).resolves.toBe('cancelled')
    expect(t.request).toHaveBeenCalledWith('account/loginCancel', {})
    expect(t.close).toHaveBeenCalledOnce()
  })

  it('reports a completed credential write when cancellation races the same poll', async () => {
    const t = session()
    const abort = new AbortController()
    let modified: number | undefined
    await expect(
      runDeviceSignIn({
        connect: () => Promise.resolve(t.deviceSession),
        credentialFileModifiedAt: () => modified,
        sleep: () => {
          modified = 2
          abort.abort()
          return Promise.resolve()
        },
        now: () => 0,
        signal: abort.signal,
        onCode: vi.fn(),
        log,
      }),
    ).resolves.toBe('signedIn')
    expect(t.request).not.toHaveBeenCalledWith('account/loginCancel', {})
    expect(t.close).toHaveBeenCalledOnce()
  })

  it('reports a credential write at the timeout boundary', async () => {
    const t = session()
    let modified: number | undefined
    let clock = 0
    await expect(
      runDeviceSignIn({
        connect: () => Promise.resolve(t.deviceSession),
        credentialFileModifiedAt: () => modified,
        sleep: () => {
          modified = 2
          clock = CREDENTIAL_POLL_TIMEOUT_MS
          return Promise.resolve()
        },
        now: () => clock,
        signal: new AbortController().signal,
        onCode: vi.fn(),
        log,
      }),
    ).resolves.toBe('signedIn')
    expect(t.request).not.toHaveBeenCalledWith('account/loginCancel', {})
  })

  // The account before the flow (D26), then the flow's start: neither holds
  // up a cancel.
  it.each([
    ['loginStart', 'account/loginStart', { type: 'deviceCode' }],
    ['the first account/read', 'account/read', {}],
  ])('closes promptly when cancelled before %s answers', async (_name, stuck, params) => {
    const t = session(() => LOGGED_OUT)
    const answer = t.request.getMockImplementation()
    t.request.mockImplementation((method) =>
      method === stuck
        ? new Promise<Record<string, unknown>>(() => undefined)
        : (answer?.(method) ?? Promise.resolve({})),
    )
    const abort = new AbortController()
    const pending = run(t, { signal: abort.signal })
    await vi.waitFor(() => {
      expect(t.request).toHaveBeenCalledWith(stuck, params)
    })
    abort.abort()
    await expect(pending).resolves.toBe('cancelled')
    expect(t.request).not.toHaveBeenCalledWith('account/loginCancel', {})
    expect(t.close).toHaveBeenCalledOnce()
  })

  it('reports cancellation while the temporary host is still connecting', async () => {
    const abort = new AbortController()
    const close = vi.fn()
    const connect = vi.fn(
      () =>
        new Promise<AccountSession>((_resolve, reject) => {
          abort.signal.addEventListener(
            'abort',
            () => {
              close()
              reject(new Error('handshake cancelled'))
            },
            { once: true },
          )
        }),
    )
    const pending = runDeviceSignIn({
      connect,
      credentialFileModifiedAt: () => undefined,
      sleep: () => Promise.resolve(),
      now: () => 0,
      signal: abort.signal,
      onCode: vi.fn(),
      log,
    })
    expect(connect).toHaveBeenCalledOnce()
    abort.abort()
    await expect(pending).resolves.toBe('cancelled')
    expect(close).toHaveBeenCalledOnce()
  })

  it('does not connect after an earlier cancellation or hide an unrelated connection failure', async () => {
    const abort = new AbortController()
    abort.abort()
    const connect = vi.fn(() => Promise.resolve(session().deviceSession))
    const deps = {
      connect,
      credentialFileModifiedAt: () => undefined,
      sleep: () => Promise.resolve(),
      now: () => 0,
      signal: abort.signal,
      onCode: vi.fn(),
      log,
    }
    await expect(runDeviceSignIn(deps)).resolves.toBe('cancelled')
    expect(connect).not.toHaveBeenCalled()

    const failure = new Error('handshake failed')
    await expect(
      runDeviceSignIn({
        ...deps,
        signal: new AbortController().signal,
        connect: () => Promise.reject(failure),
      }),
    ).rejects.toBe(failure)
  })

  it('treats the CLI cancellation notification as terminal', async () => {
    const t = session()
    let isNotified = false
    await expect(
      runDeviceSignIn({
        connect: () => Promise.resolve(t.deviceSession),
        credentialFileModifiedAt: () => undefined,
        sleep: () => {
          if (!isNotified) {
            isNotified = true
            t.onNotification.mock.calls[0]?.[0]({
              jsonrpc: '2.0',
              method: 'account/loginCompleted',
              params: { outcome: 'cancelled' },
            })
          }
          return Promise.resolve()
        },
        now: () => 0,
        signal: new AbortController().signal,
        onCode: vi.fn(),
        log,
      }),
    ).resolves.toBe('cancelled')
    expect(t.request).not.toHaveBeenCalledWith('account/loginCancel', {})
    expect(t.close).toHaveBeenCalledOnce()
  })

  it('cancels the CLI request and closes its host on timeout', async () => {
    const t = session()
    let clock = 0
    await expect(
      runDeviceSignIn({
        connect: () => Promise.resolve(t.deviceSession),
        credentialFileModifiedAt: () => undefined,
        sleep: () => Promise.resolve(),
        now: () => {
          clock += CREDENTIAL_POLL_TIMEOUT_MS / 2
          return clock
        },
        signal: new AbortController().signal,
        onCode: vi.fn(),
        log,
      }),
    ).resolves.toBe('timedOut')
    expect(t.request).toHaveBeenCalledWith('account/loginCancel', {})
    expect(t.close).toHaveBeenCalledOnce()
  })
})

interface Flow {
  /** Each poll's wait: where a test changes the host or the file. */
  readonly sleep?: () => Promise<void>
  readonly modified?: () => number | undefined
  /** How far the clock moves at each look; the default never runs out. */
  readonly step?: number
  readonly signal?: AbortSignal
  readonly log?: FakeLogOutputChannel
}

/** A flow on `t`'s host. */
function run(t: ReturnType<typeof session>, flow: Flow = {}) {
  let clock = 0
  return runDeviceSignIn({
    connect: () => Promise.resolve(t.deviceSession),
    credentialFileModifiedAt: flow.modified ?? (() => 1),
    sleep: flow.sleep ?? (() => Promise.resolve()),
    now: () => {
      clock += flow.step ?? 1
      return clock
    },
    signal: flow.signal ?? new AbortController().signal,
    onCode: vi.fn(),
    log: flow.log ?? log,
  })
}

/** A clock that runs out after one poll. */
const ONE_POLL = CREDENTIAL_POLL_TIMEOUT_MS / 2

// PLAN.md D26 (2026-09-27): the host's own ending, `account/read` on the open
// host, and the credential file, in that order of trust.
describe('Muse Code device sign-in: how it ends', () => {
  it('finishes on a granted outcome the account confirms, with no file change', async () => {
    let account = LOGGED_OUT
    const t = session(() => account)
    const sleep = () => {
      account = SIGNED_IN
      t.complete({ outcome: 'granted' })
      return Promise.resolve()
    }
    await expect(run(t, { sleep })).resolves.toBe('signedIn')
    expect(t.request).toHaveBeenCalledWith('account/read', {})
    expect(t.request).not.toHaveBeenCalledWith('account/loginCancel', {})
    expect(t.close).toHaveBeenCalledOnce()
  })

  it('waits while the store does not show a granted sign-in yet', async () => {
    const accounts = [LOGGED_OUT, LOGGED_OUT, LOGGED_OUT, SIGNED_IN]
    const t = session(() => accounts.shift() ?? SIGNED_IN)
    let polls = 0
    const sleep = () => {
      polls += 1
      t.complete({ outcome: 'granted' })
      return Promise.resolve()
    }
    await expect(run(t, { sleep })).resolves.toBe('signedIn')
    expect(polls).toBe(2)
  })

  it('notices a sign-in by polling account/read when no outcome arrives', async () => {
    let account = LOGGED_OUT
    const t = session(() => account)
    const sleep = () => {
      account = SIGNED_IN
      return Promise.resolve()
    }
    await expect(run(t, { sleep })).resolves.toBe('signedIn')
  })

  it('does not take a file a sign-out rewrote for a sign-in', async () => {
    const t = session(() => LOGGED_OUT)
    let modified = 1
    const sleep = () => {
      modified += 1
      return Promise.resolve()
    }
    await expect(run(t, { sleep, modified: () => modified, step: ONE_POLL })).resolves.toBe(
      'timedOut',
    )
  })

  it('counts a new file while META_API_KEY masks the login', async () => {
    const t = session(() => ({ state: 'envKey', credentialRequired: true }))
    let modified = 1
    const sleep = () => {
      modified = 2
      return Promise.resolve()
    }
    await expect(run(t, { sleep, modified: () => modified })).resolves.toBe('signedIn')
  })

  it.each(['denied', 'expired', 'failed'] as const)(
    'ends at once on %s, logs the host’s reason, and needs no loginCancel',
    async (outcome) => {
      const t = session(() => LOGGED_OUT)
      const logged = new FakeLogOutputChannel()
      const sleep = () => {
        t.complete({ outcome, message: `the flow was ${outcome}` })
        return Promise.resolve()
      }
      await expect(run(t, { sleep, log: logged })).resolves.toBe(outcome)
      expect(t.request).not.toHaveBeenCalledWith('account/loginCancel', {})
      expect(t.close).toHaveBeenCalledOnce()
      expect(logged.info).toHaveBeenCalledWith(
        `Muse Code sign-in ended: ${outcome}: the flow was ${outcome}`,
      )
    },
  )

  it.each([
    ['an outcome it does not know, keeping the first ending', ['somethingNew', 'denied']],
    ['a malformed ending', [undefined]],
  ])('keeps waiting on %s', async (_name, outcomes) => {
    const t = session(() => LOGGED_OUT)
    const sleep = () => {
      for (const outcome of outcomes) {
        t.complete(outcome === undefined ? { result: 'denied' } : { outcome })
      }
      return Promise.resolve()
    }
    await expect(run(t, { sleep, step: ONE_POLL })).resolves.toBe('timedOut')
    expect(t.request).toHaveBeenCalledWith('account/loginCancel', {})
  })

  it('never logs the account’s label', async () => {
    const logged = new FakeLogOutputChannel()
    const t = session(() => SIGNED_IN)
    const sleep = () => {
      t.complete({ outcome: 'granted' })
      return Promise.resolve()
    }
    await run(t, { sleep, log: logged })
    const everything = [...logged.info.mock.calls, ...logged.warn.mock.calls].flat().join('\n')
    expect(everything).not.toContain('person@example.com')
  })
})
