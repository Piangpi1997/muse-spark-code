import { describe, expect, it, vi } from 'vitest'
import { CREDENTIAL_POLL_TIMEOUT_MS } from '../../src/shared/constants'
import {
  parseDeviceCode,
  runDeviceSignIn,
  type DeviceSession,
} from '../../src/host/auth/deviceSignIn'

const DEVICE_URL = 'https://auth.meta.com/oauth/device/?code=example'

function session() {
  const request = vi.fn((method: string) => {
    return method === 'account/loginStart'
      ? Promise.resolve({ verificationUrl: DEVICE_URL, userCode: 'ABCD-EFGH' })
      : Promise.resolve({ cancelled: true })
  })
  const onNotification = vi.fn<DeviceSession['connection']['onNotification']>()
  const close = vi.fn(() => Promise.resolve())
  const deviceSession: DeviceSession = { connection: { request, onNotification }, close }
  return { request, onNotification, close, deviceSession }
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
      }),
    ).resolves.toBe('signedIn')
    expect(t.request).not.toHaveBeenCalledWith('account/loginCancel', {})
  })

  it('closes promptly when cancelled before loginStart answers', async () => {
    const t = session()
    t.request.mockImplementation(
      () => new Promise<{ verificationUrl: string; userCode: string }>(() => undefined),
    )
    const abort = new AbortController()
    const pending = runDeviceSignIn({
      connect: () => Promise.resolve(t.deviceSession),
      credentialFileModifiedAt: () => undefined,
      sleep: () => Promise.resolve(),
      now: () => 0,
      signal: abort.signal,
      onCode: vi.fn(),
    })
    await vi.waitFor(() => {
      expect(t.request).toHaveBeenCalledWith('account/loginStart', { type: 'deviceCode' })
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
        new Promise<DeviceSession>((_resolve, reject) => {
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
      }),
    ).resolves.toBe('timedOut')
    expect(t.request).toHaveBeenCalledWith('account/loginCancel', {})
    expect(t.close).toHaveBeenCalledOnce()
  })
})
