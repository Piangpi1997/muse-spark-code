import { describe, expect, it, vi } from 'vitest'
import {
  type AccountSession,
  isStoredSignIn,
  logOutAccount,
  probeAccount,
  readAccountState,
} from '../../src/host/auth/accountHost'
import { FakeLogOutputChannel } from './helpers/fakes'

// `account/read` and `account/logout` as captured (1.3.0 and 1.4.0-R4302.1,
// isolated homes, 2026-09-27); the label was redacted there and is an
// e-mail address in real life.
const LOGGED_OUT = { state: 'loggedOut', credentialRequired: true }
const STORED_KEY = { state: 'apiKey', label: 'person@example.com', credentialRequired: true }

type Answer = Record<string, unknown> | Error

function host(answers: Record<string, Answer | (() => Answer)>) {
  const request = vi.fn((method: string) => {
    const entry = answers[method]
    const answer = typeof entry === 'function' ? entry() : entry
    if (answer === undefined) {
      return Promise.reject(new Error(`no handler for ${method}`))
    }
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
  })
  const close = vi.fn(() => Promise.resolve())
  const session: AccountSession = { connection: { request, onNotification: vi.fn() }, close }
  return { request, close, session, connect: () => Promise.resolve(session) }
}

function allLogged(log: FakeLogOutputChannel): string {
  return [...log.info.mock.calls, ...log.warn.mock.calls].flat().join('\n')
}

describe('readAccountState', () => {
  it('keeps the state and drops the label', async () => {
    const t = host({ 'account/read': STORED_KEY })
    await expect(readAccountState(t.session.connection)).resolves.toEqual({
      state: 'apiKey',
      credentialRequired: true,
    })
  })

  it('says nothing for an unknown method or an unexpected shape', async () => {
    await expect(readAccountState(host({}).session.connection)).resolves.toBeUndefined()
    await expect(
      readAccountState(host({ 'account/read': { state: 'loggedOut' } }).session.connection),
    ).resolves.toBeUndefined()
  })
})

describe('isStoredSignIn', () => {
  it('is a login or a stored key, not an environment key or none', () => {
    expect(isStoredSignIn({ state: 'accountLogin', credentialRequired: true })).toBe(true)
    expect(isStoredSignIn({ state: 'apiKey', credentialRequired: true })).toBe(true)
    expect(isStoredSignIn({ state: 'envKey', credentialRequired: true })).toBe(false)
    expect(isStoredSignIn(LOGGED_OUT)).toBe(false)
  })
})

describe('probeAccount', () => {
  it('asks one host and closes it', async () => {
    const t = host({ 'account/read': LOGGED_OUT })
    const log = new FakeLogOutputChannel()
    await expect(probeAccount(t.connect, log)).resolves.toEqual(LOGGED_OUT)
    expect(t.close).toHaveBeenCalledOnce()
  })

  it('says nothing when the host cannot start, naming only the error', async () => {
    const log = new FakeLogOutputChannel()
    const failure = new Error(String.raw`failed at C:\Users\someone\.config\muse\auth.json`)
    await expect(probeAccount(() => Promise.reject(failure), log)).resolves.toBeUndefined()
    expect(log.warn).toHaveBeenCalledWith('The Muse Code account host could not start: Error')
    expect(allLogged(log)).not.toContain('auth.json')
  })

  it('reports a host that does not close cleanly and keeps the answer', async () => {
    const t = host({ 'account/read': LOGGED_OUT })
    t.close.mockRejectedValue(new Error('still draining'))
    const log = new FakeLogOutputChannel()
    await expect(probeAccount(t.connect, log)).resolves.toEqual(LOGGED_OUT)
    expect(log.warn).toHaveBeenCalledWith('The Muse Code account host did not close cleanly: Error')
  })
})

describe('logOutAccount', () => {
  it('signs out and confirms with account/read', async () => {
    let state: Answer = STORED_KEY
    const t = host({
      'account/logout': () => {
        state = LOGGED_OUT
        return LOGGED_OUT
      },
      'account/read': () => state,
    })
    const log = new FakeLogOutputChannel()
    await expect(logOutAccount(t.connect, log)).resolves.toBe('confirmed')
    expect(t.request.mock.calls.map(([method]) => method)).toEqual([
      'account/logout',
      'account/read',
    ])
    expect(t.close).toHaveBeenCalledOnce()
    expect(allLogged(log)).not.toContain('person@example.com')
  })

  it('leaves META_API_KEY to the caller: an environment key afterwards still confirms', async () => {
    const envKey = { state: 'envKey', credentialRequired: true }
    const t = host({ 'account/logout': envKey, 'account/read': envKey })
    await expect(logOutAccount(t.connect, new FakeLogOutputChannel())).resolves.toBe('confirmed')
  })

  it.each([
    ['the host cannot start', undefined],
    ['account/logout is refused', { 'account/logout': new Error('experimentalRequired') }],
    ['account/logout answers another shape', { 'account/logout': { ok: true } }],
    ['a stored sign-in remains', { 'account/logout': LOGGED_OUT, 'account/read': STORED_KEY }],
    ['account/read cannot confirm', { 'account/logout': LOGGED_OUT }],
  ])('is false when %s', async (_name, answers) => {
    const log = new FakeLogOutputChannel()
    if (answers === undefined) {
      await expect(logOutAccount(() => Promise.reject(new Error('no CLI')), log)).resolves.toBe(
        'unconfirmed',
      )
      return
    }
    const t = host(answers)
    await expect(logOutAccount(t.connect, log)).resolves.toBe('unconfirmed')
    expect(t.close).toHaveBeenCalledOnce()
    expect(log.warn).toHaveBeenCalled()
  })
})
