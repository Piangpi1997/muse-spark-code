import { describe, expect, it, vi } from 'vitest'
import type { AccountSession } from '../../src/host/auth/accountHost'
import {
  CREDENTIAL_POLL_TIMEOUT_MS,
  MUSE_LOGIN_CANCEL_TIMEOUT_MS,
} from '../../src/shared/constants'
import { parseDeviceCode, runDeviceSignIn } from '../../src/host/auth/deviceSignIn'
import {
  CAPTURED_CANCEL_AFTER_ENDING,
  CAPTURED_CANCEL_ANSWER,
  CAPTURED_CANCELLED_ENDING,
  CAPTURED_CODE_LIFETIME_MS,
  CAPTURED_EXPIRED_ENDING,
  CAPTURED_LOGGED_OUT,
  CAPTURED_LOGIN_START,
  endingNamed,
} from './helpers/accountLoginCapture'
import { FakeLogOutputChannel } from './helpers/fakes'

// As captured (1.4.0-R4302.1, 2026-09-27): the user code is its shape.
const DEVICE_URL = 'https://auth.meta.com/oauth/device/?code=AAAA-AAAA'
const DEVICE_CODE = 'AAAA-AAAA'
const log = new FakeLogOutputChannel()

// `account/read` signed in, as captured on 1.3.0 and 1.4.0 (the label
// redacted there, an e-mail address in real life, and dropped by the parser
// here).
const SIGNED_IN = { state: 'accountLogin', label: 'person@example.com', credentialRequired: true }

type AccountAnswer = Record<string, unknown> | undefined
type Notify = Parameters<AccountSession['connection']['onNotification']>[0]

/** A promise that never settles: a CLI that stopped answering. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined)
}

/**
 * A sign-in host replaying the captured frames. `account` answers
 * `account/read` (undefined: a CLI that refuses it). `account/loginCancel`
 * sends the captured `cancelled` ending before its answer, as captured, and
 * answers `{cancelled: false}` once the flow has ended.
 */
function session(account: () => AccountAnswer = () => undefined) {
  let notify: Notify | undefined
  let hasEnded = false
  const complete = (frame: Parameters<Notify>[0]) => {
    hasEnded = true
    notify?.(frame)
  }
  const request = vi.fn((method: string): Promise<Record<string, unknown>> => {
    if (method === 'account/loginStart') {
      return Promise.resolve(CAPTURED_LOGIN_START)
    }
    if (method === 'account/read') {
      const answer = account()
      return answer === undefined
        ? Promise.reject(new Error('no handler for account/read'))
        : Promise.resolve(answer)
    }
    if (hasEnded) {
      return Promise.resolve(CAPTURED_CANCEL_AFTER_ENDING)
    }
    complete(CAPTURED_CANCELLED_ENDING)
    return Promise.resolve(CAPTURED_CANCEL_ANSWER)
  })
  const onNotification = vi.fn((handler: Notify) => {
    notify = handler
  })
  const close = vi.fn(() => Promise.resolve())
  const deviceSession: AccountSession = { connection: { request, onNotification }, close }
  return { request, onNotification, close, deviceSession, complete }
}

describe('Muse Code device sign-in', () => {
  it('accepts the captured code shape only from Meta auth', () => {
    expect(parseDeviceCode(CAPTURED_LOGIN_START)).toEqual({ url: DEVICE_URL, code: DEVICE_CODE })
    expect(() =>
      parseDeviceCode({ ...CAPTURED_LOGIN_START, verificationUrl: 'https://example.com/' }),
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
    expect(onCode).toHaveBeenCalledWith(DEVICE_URL, DEVICE_CODE)
    expect(t.request).toHaveBeenCalledWith('account/loginStart', { type: 'deviceCode' })
    expect(t.close).toHaveBeenCalledOnce()
  })

  // A stop decides the flow: a file written as Cancel lands is not a sign-in
  // on its own (an unrelated sign-out rewrites the file too). A real sign-in
  // is still seen afterwards from the file's structure (the review of PR #49).
  it.each([
    ['with no credential write', false],
    ['racing a credential write in the same poll', true],
  ])(
    'sends loginCancel after user cancellation %s and closes the host',
    async (_name, isWritten) => {
      const t = session()
      const abort = new AbortController()
      let modified: number | undefined
      await expect(
        runDeviceSignIn({
          connect: () => Promise.resolve(t.deviceSession),
          credentialFileModifiedAt: () => modified,
          sleep: () => {
            modified = isWritten ? 2 : undefined
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
    },
  )

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
    const t = session(() => CAPTURED_LOGGED_OUT)
    const answer = t.request.getMockImplementation()
    t.request.mockImplementation((method) =>
      method === stuck ? never() : (answer?.(method) ?? Promise.resolve({})),
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

  it('ends on the host’s ending while loginStart is unanswered, with no code shown', async () => {
    const t = session(() => CAPTURED_LOGGED_OUT)
    const answer = t.request.getMockImplementation()
    t.request.mockImplementation((method) =>
      method === 'account/loginStart' ? never() : (answer?.(method) ?? Promise.resolve({})),
    )
    const onCode = vi.fn()
    const pending = runDeviceSignIn({
      connect: () => Promise.resolve(t.deviceSession),
      credentialFileModifiedAt: () => undefined,
      sleep: () => Promise.resolve(),
      now: () => 0,
      signal: new AbortController().signal,
      onCode,
      log,
    })
    await vi.waitFor(() => {
      expect(t.request).toHaveBeenCalledWith('account/loginStart', { type: 'deviceCode' })
    })
    t.complete(CAPTURED_EXPIRED_ENDING)
    await expect(pending).resolves.toBe('expired')
    expect(onCode).not.toHaveBeenCalled()
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

  it('treats the captured cancellation ending as terminal', async () => {
    const t = session()
    let isNotified = false
    const sleep = () => {
      if (!isNotified) {
        isNotified = true
        t.complete(CAPTURED_CANCELLED_ENDING)
      }
      return Promise.resolve()
    }
    await expect(run(t, { sleep, modified: () => undefined })).resolves.toBe('cancelled')
    expect(t.request).not.toHaveBeenCalledWith('account/loginCancel', {})
    expect(t.close).toHaveBeenCalledOnce()
  })

  it('cancels the CLI request and closes its host on timeout', async () => {
    const t = session()
    await expect(run(t, { step: CREDENTIAL_POLL_TIMEOUT_MS / 2 })).resolves.toBe('timedOut')
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

// PLAN.md D26 (2026-09-27): `account/read` on the open host and the
// credential file decide a sign-in; the host's captured endings end the flow.
describe('Muse Code device sign-in: how it ends', () => {
  it('notices a sign-in by polling account/read', async () => {
    let account: AccountAnswer = CAPTURED_LOGGED_OUT
    const t = session(() => account)
    const sleep = () => {
      account = SIGNED_IN
      return Promise.resolve()
    }
    await expect(run(t, { sleep })).resolves.toBe('signedIn')
    expect(t.request).toHaveBeenCalledWith('account/read', {})
    expect(t.request).not.toHaveBeenCalledWith('account/loginCancel', {})
    expect(t.close).toHaveBeenCalledOnce()
  })

  // `granted` was not captured: its word neither ends the flow nor signs in.
  it('takes an uncaptured granted for nothing: account/read decides', async () => {
    const accounts: AccountAnswer[] = [
      CAPTURED_LOGGED_OUT,
      CAPTURED_LOGGED_OUT,
      CAPTURED_LOGGED_OUT,
    ]
    const t = session(() => accounts.shift() ?? SIGNED_IN)
    let polls = 0
    const sleep = () => {
      polls += 1
      t.complete(endingNamed('granted'))
      return Promise.resolve()
    }
    await expect(run(t, { sleep })).resolves.toBe('signedIn')
    expect(polls).toBe(2)
  })

  it('keeps waiting after an uncaptured granted the account never shows', async () => {
    const t = session(() => CAPTURED_LOGGED_OUT)
    const sleep = () => {
      t.complete(endingNamed('granted'))
      return Promise.resolve()
    }
    await expect(run(t, { sleep, step: ONE_POLL })).resolves.toBe('timedOut')
    expect(t.request).toHaveBeenCalledWith('account/loginCancel', {})
  })

  it('does not take a file a sign-out rewrote for a sign-in', async () => {
    const t = session(() => CAPTURED_LOGGED_OUT)
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

  // A shorter limit cancelled codes the browser could still approve, and
  // Muse Code's own `expired` never arrived.
  it('waits past the captured code lifetime, so Muse Code ends an unapproved code itself', () => {
    expect(CAPTURED_CODE_LIFETIME_MS).toBeGreaterThan(10 * 60 * 1000)
    expect(CREDENTIAL_POLL_TIMEOUT_MS).toBeGreaterThan(CAPTURED_CODE_LIFETIME_MS)
  })

  it('ends at once on the captured expired ending, logs its message, and sends no loginCancel', async () => {
    const t = session(() => CAPTURED_LOGGED_OUT)
    const logged = new FakeLogOutputChannel()
    const sleep = () => {
      t.complete(CAPTURED_EXPIRED_ENDING)
      return Promise.resolve()
    }
    await expect(run(t, { sleep, log: logged })).resolves.toBe('expired')
    expect(t.request).not.toHaveBeenCalledWith('account/loginCancel', {})
    expect(t.close).toHaveBeenCalledOnce()
    expect(logged.info).toHaveBeenCalledWith(
      'Muse Code sign-in ended: expired: login failed: the request expired',
    )
  })

  // Rule 13: an ending no capture covers is shown as the CLI named it.
  it.each(['denied', 'failed', 'somethingNew'])(
    'ends at once on %s, which no capture covers, as the CLI named it',
    async (outcome) => {
      const t = session(() => CAPTURED_LOGGED_OUT)
      const sleep = () => {
        t.complete(endingNamed(outcome))
        return Promise.resolve()
      }
      await expect(run(t, { sleep })).resolves.toEqual({ endedAs: outcome })
      expect(t.request).not.toHaveBeenCalledWith('account/loginCancel', {})
      expect(t.close).toHaveBeenCalledOnce()
    },
  )

  it('cuts a long outcome word before it is shown', async () => {
    const t = session(() => CAPTURED_LOGGED_OUT)
    const sleep = () => {
      t.complete(endingNamed('x'.repeat(100)))
      return Promise.resolve()
    }
    await expect(run(t, { sleep })).resolves.toEqual({ endedAs: `${'x'.repeat(40)}…` })
  })

  it('keeps the first ending', async () => {
    const t = session(() => CAPTURED_LOGGED_OUT)
    const sleep = () => {
      t.complete(CAPTURED_EXPIRED_ENDING)
      t.complete(endingNamed('somethingNew'))
      return Promise.resolve()
    }
    await expect(run(t, { sleep })).resolves.toBe('expired')
  })

  it.each([
    ['no outcome', { ...CAPTURED_EXPIRED_ENDING, params: { result: 'denied' } }],
    ['an empty outcome', endingNamed('')],
  ])('keeps waiting on an ending with %s', async (_name, frame) => {
    const t = session(() => CAPTURED_LOGGED_OUT)
    const sleep = () => {
      t.complete(frame)
      return Promise.resolve()
    }
    await expect(run(t, { sleep, step: ONE_POLL })).resolves.toBe('timedOut')
  })

  it('never logs the account’s label', async () => {
    const logged = new FakeLogOutputChannel()
    const accounts: AccountAnswer[] = [CAPTURED_LOGGED_OUT]
    const t = session(() => accounts.shift() ?? SIGNED_IN)
    await expect(run(t, { log: logged })).resolves.toBe('signedIn')
    const everything = [...logged.info.mock.calls, ...logged.warn.mock.calls].flat().join('\n')
    expect(everything).not.toContain('person@example.com')
  })
})

/**
 * A host that answers the first `account/read` (the account before the
 * flow) and then stops answering it, as a wedged CLI would (PR #49 P2).
 */
function wedgedSession() {
  let reads = 0
  const t = session(() => CAPTURED_LOGGED_OUT)
  const answer = t.request.getMockImplementation()
  t.request.mockImplementation((method) => {
    if (method === 'account/read') {
      reads += 1
      if (reads > 1) {
        return never()
      }
    }
    return answer?.(method) ?? Promise.resolve({})
  })
  const polling = async () => {
    await vi.waitFor(() => {
      expect(reads).toBe(2)
    })
  }
  return { t, polling }
}

// PR #49 P2: an unanswered `account/read` holds up neither Cancel nor the
// host's ending, and an unanswered `loginCancel` does not hold up the close.
describe('Muse Code device sign-in: a CLI that stops answering', () => {
  it('ends on the host’s ending, not a sign-in, when the file changes while a poll is unanswered', async () => {
    const { t, polling } = wedgedSession()
    let modified = 1
    const pending = run(t, { modified: () => modified })
    await polling()
    // An unrelated sign-out rewrites the file as the code expires.
    modified = 2
    t.complete(CAPTURED_EXPIRED_ENDING)
    await expect(pending).resolves.toBe('expired')
  })

  it('notices Cancel at once while a poll is unanswered', async () => {
    const { t, polling } = wedgedSession()
    const abort = new AbortController()
    const pending = run(t, { signal: abort.signal })
    await polling()
    abort.abort()
    await expect(pending).resolves.toBe('cancelled')
    expect(t.request).toHaveBeenCalledWith('account/loginCancel', {})
    expect(t.close).toHaveBeenCalledOnce()
  })

  it.each([
    ['the captured expired ending', CAPTURED_EXPIRED_ENDING, 'expired'],
    ['an ending no capture covers', endingNamed('denied'), { endedAs: 'denied' }],
  ])('ends at once on %s while a poll is unanswered', async (_name, frame, outcome) => {
    const { t, polling } = wedgedSession()
    const pending = run(t)
    await polling()
    t.complete(frame)
    await expect(pending).resolves.toEqual(outcome)
    expect(t.request).not.toHaveBeenCalledWith('account/loginCancel', {})
    expect(t.close).toHaveBeenCalledOnce()
  })

  it('notices Cancel during the wait between polls', async () => {
    const t = session(() => CAPTURED_LOGGED_OUT)
    const abort = new AbortController()
    const sleep = vi.fn(() => never<undefined>())
    const pending = run(t, { signal: abort.signal, sleep })
    await vi.waitFor(() => {
      expect(sleep).toHaveBeenCalled()
    })
    abort.abort()
    await expect(pending).resolves.toBe('cancelled')
  })

  it.each([
    ['Cancel', 'cancelled'],
    ['the timeout', 'timedOut'],
  ] as const)(
    'closes the host after %s even when loginCancel is never answered',
    async (name, outcome) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const isCancel = name === 'Cancel'
        // Cancel while a poll is unanswered; or every poll answered and the
        // clock run out.
        const { t, polling } = isCancel
          ? wedgedSession()
          : { t: session(() => CAPTURED_LOGGED_OUT), polling: () => Promise.resolve() }
        const answer = t.request.getMockImplementation()
        t.request.mockImplementation((method) =>
          method === 'account/loginCancel' ? never() : (answer?.(method) ?? Promise.resolve({})),
        )
        const logged = new FakeLogOutputChannel()
        const abort = new AbortController()
        const pending = run(t, {
          signal: abort.signal,
          log: logged,
          ...(!isCancel && { step: ONE_POLL }),
        })
        await polling()
        if (isCancel) {
          abort.abort()
        }
        await vi.waitFor(() => {
          expect(t.request).toHaveBeenCalledWith('account/loginCancel', {})
        })
        await vi.advanceTimersByTimeAsync(MUSE_LOGIN_CANCEL_TIMEOUT_MS)
        await expect(pending).resolves.toBe(outcome)
        expect(t.close).toHaveBeenCalledOnce()
        expect(logged.warn).toHaveBeenCalledWith(
          'Muse Code did not confirm the sign-in cancel; closing its host',
        )
      } finally {
        vi.useRealTimers()
      }
    },
  )
})
