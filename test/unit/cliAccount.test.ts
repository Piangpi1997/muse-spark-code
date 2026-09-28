import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountState } from '../../src/host/auth/accountHost'
import {
  CliAccount,
  cliSignInFromAccount,
  isCliSignedIn,
  readCredentialFile,
} from '../../src/host/auth/cliAccount'
import { MUSE_CREDENTIAL_FILE_MAX_BYTES } from '../../src/shared/constants'
import { FakeLogOutputChannel } from './helpers/fakes'

// What Muse Code 1.3.0 and 1.4.0 write (isolated homes, 2026-09-27) and
// macOS's pointer (aonia §2.3); placeholders, never a token.
const LOGOUT_SHELL = '{\n  "schema_version": 1,\n  "providers": {}\n}'
const STORED_SIGN_IN = '{"schema_version":1,"providers":{"meta":{"mechanism":"oauth"}}}'
const MAC_POINTER =
  '{"schema_version":2,"providers":{"meta":{"mechanism":"oauth","storage":"keychain"}}}'
const MALFORMED = '{"schema_version": 1, "providers": '

const SIGNED_IN: AccountState = { state: 'accountLogin', credentialRequired: true }
const LOGGED_OUT: AccountState = { state: 'loggedOut', credentialRequired: true }

const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true })
  }
})

function configHome(): { readonly file: string; readonly write: (text: string) => void } {
  const home = mkdtempSync(path.join(tmpdir(), 'muse-cred-'))
  homes.push(home)
  const file = path.join(home, 'muse', 'auth.json')
  mkdirSync(path.dirname(file), { recursive: true })
  return {
    file,
    write: (text) => {
      writeFileSync(file, text)
    },
  }
}

/** A later modification time, as a new write would leave. */
function touchLater(file: string, seconds: number): void {
  const at = new Date(Date.now() + seconds * 1000)
  utimesSync(file, at, at)
}

function account(platform: NodeJS.Platform, file: string, answers: (AccountState | undefined)[]) {
  const probe = vi.fn(() => Promise.resolve(answers.shift()))
  const log = new FakeLogOutputChannel()
  const checker = new CliAccount({ platform, credentialFilePath: () => file, probe, log })
  return { checker, probe, log }
}

/** A Linux checker over the file, asking the given probe. */
function linuxChecker(file: string, probe: () => Promise<AccountState | undefined>) {
  return new CliAccount({
    platform: 'linux',
    credentialFilePath: () => file,
    probe,
    log: new FakeLogOutputChannel(),
  })
}

/** An ambiguous file on Linux whose CLI question waits until the test answers it. */
function heldQuestion() {
  const home = configHome()
  home.write(MALFORMED)
  const answer = Promise.withResolvers<AccountState | undefined>()
  const probe = vi.fn(() => answer.promise)
  return { home, answer, probe, checker: linuxChecker(home.file, probe) }
}

describe('readCredentialFile', () => {
  it('is nothing when there is no file', () => {
    const home = configHome()
    expect(readCredentialFile(home.file, 'win32')).toBeUndefined()
    expect(readCredentialFile(path.join(home.file, 'deeper'), 'win32')).toBeUndefined()
  })

  it('reads the structure and signs it by size and modification time', () => {
    const home = configHome()
    home.write(LOGOUT_SHELL)
    const reading = readCredentialFile(home.file, 'linux')
    expect(reading?.verdict).toBe('empty')
    expect(reading?.signature).toMatch(/^44:\d+(\.\d+)?$/)
  })

  it('does not read a folder or an oversized file', () => {
    const home = configHome()
    mkdirSync(home.file)
    expect(readCredentialFile(home.file, 'linux')).toEqual({
      signature: 'unreadable',
      verdict: 'unrecognized',
    })
    const other = configHome()
    other.write(' '.repeat(MUSE_CREDENTIAL_FILE_MAX_BYTES + 1))
    expect(readCredentialFile(other.file, 'linux')?.verdict).toBe('unrecognized')
  })
})

describe('cliSignInFromAccount', () => {
  it('maps the CLI’s answer, never guessing past it', () => {
    expect(cliSignInFromAccount(undefined)).toBe('unknown')
    expect(cliSignInFromAccount(SIGNED_IN)).toBe('signedIn')
    expect(cliSignInFromAccount({ state: 'apiKey', credentialRequired: true })).toBe('signedIn')
    expect(cliSignInFromAccount(LOGGED_OUT)).toBe('signedOut')
    // Never captured: its meaning is not guessed at (the review of PR #49).
    expect(cliSignInFromAccount({ state: 'loggedOut', credentialRequired: false })).toBe('unknown')
    // META_API_KEY hides the stored lane; a future state is not guessed at.
    expect(cliSignInFromAccount({ state: 'envKey', credentialRequired: true })).toBe('unknown')
    expect(cliSignInFromAccount({ state: 'somethingNew', credentialRequired: true })).toBe(
      'unknown',
    )
  })

  it('counts unknown as signed in for the estimate', () => {
    expect(isCliSignedIn('signedIn')).toBe(true)
    expect(isCliSignedIn('unknown')).toBe(true)
    expect(isCliSignedIn('signedOut')).toBe(false)
    expect(isCliSignedIn('keychainElsewhere')).toBe(false)
  })
})

describe('CliAccount', () => {
  it('reads no file and the file a sign-out leaves as signed out, starting no process', async () => {
    const home = configHome()
    const t = account('win32', home.file, [])
    await expect(t.checker.signIn(true)).resolves.toBe('signedOut')
    expect(readCredentialFile(home.file, 'win32')).toBeUndefined()
    home.write(LOGOUT_SHELL)
    await expect(t.checker.signIn(true)).resolves.toBe('signedOut')
    expect(readCredentialFile(home.file, 'win32')?.verdict).toBe('empty')
    expect(t.probe).not.toHaveBeenCalled()
  })

  it('reads a stored sign-in as signed in without asking', async () => {
    const home = configHome()
    home.write(STORED_SIGN_IN)
    const t = account('linux', home.file, [])
    await expect(t.checker.signIn(false)).resolves.toBe('signedIn')
    expect(t.probe).not.toHaveBeenCalled()
  })

  it('names a macOS pointer on Windows without starting a host that would exit', async () => {
    const home = configHome()
    home.write(MAC_POINTER)
    const t = account('win32', home.file, [])
    await expect(t.checker.signIn(true)).resolves.toBe('keychainElsewhere')
    expect(t.probe).not.toHaveBeenCalled()
  })

  it('asks about a macOS Keychain pointer only on a user action', async () => {
    const home = configHome()
    home.write(MAC_POINTER)
    const t = account('darwin', home.file, [SIGNED_IN])
    await expect(t.checker.signIn(false)).resolves.toBe('unknown')
    expect(t.probe).not.toHaveBeenCalled()
    await expect(t.checker.signIn(true)).resolves.toBe('signedIn')
    expect(t.probe).toHaveBeenCalledOnce()
    // The answer stands, passive or not, until the file changes.
    await expect(t.checker.signIn(false)).resolves.toBe('signedIn')
    await expect(t.checker.signIn(true)).resolves.toBe('signedIn')
    expect(t.probe).toHaveBeenCalledOnce()
    expect(t.log.info).toHaveBeenCalledWith(
      'Muse Code sign-in confirmed by account/read: accountLogin (signedIn)',
    )
  })

  it('asks about a malformed file off macOS at once, and keeps the answer until it changes', async () => {
    const home = configHome()
    home.write(MALFORMED)
    const t = account('win32', home.file, [LOGGED_OUT, SIGNED_IN])
    await expect(t.checker.signIn(false)).resolves.toBe('signedOut')
    await expect(t.checker.signIn(false)).resolves.toBe('signedOut')
    expect(t.probe).toHaveBeenCalledOnce()
    // Same size, new modification time: asked again.
    touchLater(home.file, 60)
    await expect(t.checker.signIn(false)).resolves.toBe('signedIn')
    expect(t.probe).toHaveBeenCalledTimes(2)
  })

  it('asks again when the size changes', async () => {
    const home = configHome()
    home.write(MALFORMED)
    const t = account('linux', home.file, [LOGGED_OUT, SIGNED_IN])
    await t.checker.signIn(false)
    home.write(`${MALFORMED} `)
    await expect(t.checker.signIn(false)).resolves.toBe('signedIn')
    expect(t.probe).toHaveBeenCalledTimes(2)
  })

  it('keeps a failed answer for passive looks, and asks again on a user action', async () => {
    const home = configHome()
    home.write(MALFORMED)
    const t = account('linux', home.file, [undefined, LOGGED_OUT])
    await expect(t.checker.signIn(false)).resolves.toBe('unknown')
    await expect(t.checker.signIn(false)).resolves.toBe('unknown')
    expect(t.probe).toHaveBeenCalledOnce()
    await expect(t.checker.signIn(true)).resolves.toBe('signedOut')
    expect(t.probe).toHaveBeenCalledTimes(2)
    expect(t.log.info).toHaveBeenCalledWith(
      'Muse Code sign-in confirmed by account/read: no answer (unknown)',
    )
  })

  it('shares one question among callers asking at once', async () => {
    const { answer, probe, checker } = heldQuestion()
    const first = checker.signIn(false)
    const second = checker.signIn(true)
    answer.resolve(SIGNED_IN)
    await expect(Promise.all([first, second])).resolves.toEqual(['signedIn', 'signedIn'])
    expect(probe).toHaveBeenCalledOnce()
  })

  it('looks again when the file is rewritten while the CLI answers (the review of PR #49)', async () => {
    const { home, answer, checker } = heldQuestion()
    const pending = checker.signIn(true)
    // A sign-out rewrites the file while the old question is out.
    home.write(LOGOUT_SHELL)
    answer.resolve(SIGNED_IN)
    await expect(pending).resolves.toBe('signedOut')
  })

  it('asks afresh after an unanswered probe is abandoned, and forgets its late answer (the review of PR #49)', async () => {
    const home = configHome()
    home.write(MALFORMED)
    const stale = Promise.withResolvers<AccountState | undefined>()
    const answers = [stale.promise, Promise.resolve(LOGGED_OUT)]
    const probe = vi.fn(() => answers.shift() ?? Promise.resolve(undefined))
    const checker = linuxChecker(home.file, probe)
    const abandoned = checker.signIn(true)
    checker.forgetAnswers()
    await expect(checker.signIn(true)).resolves.toBe('signedOut')
    expect(probe).toHaveBeenCalledTimes(2)
    // The first probe answers late: it settles its own caller only.
    stale.resolve(SIGNED_IN)
    await expect(abandoned).resolves.toBe('signedIn')
    await expect(checker.signIn(false)).resolves.toBe('signedOut')
    expect(probe).toHaveBeenCalledTimes(2)
  })
})
