// The CLI's sign-in against a real child process (PLAN.md D26): the real
// backend manager spawns the fake CLI (fake-muse/serve.mjs) as a short-lived
// experimental host, asks it `account/read` about a credential file whose
// structure cannot say, and signs out through `account/logout`, which leaves
// the file behind, emptied, as Muse Code does. The device sign-in runs
// against the same fake replaying the frames captured live on 1.4.0-R4302.1.
// No token is in any file.

import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout } from 'node:timers'
import { EXPECTED_SCHEMA_FINGERPRINT } from '@muse-code/sdk'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { connectAccountSession, logOutAccount, probeAccount } from '../../src/host/auth/accountHost'
import { CliAccount, readCredentialFile } from '../../src/host/auth/cliAccount'
import { runDeviceSignIn } from '../../src/host/auth/deviceSignIn'
import { MuseCodeBackendManager } from '../../src/host/backend/museCodeBackendManager'
import { CAPTURES_FOLDER } from '../unit/helpers/accountLoginCapture'
import { FakeLogOutputChannel } from '../unit/helpers/fakes'
import {
  FAKE_STORED_SIGN_IN,
  fakeCredentialFile,
  installFakeCredential,
  installFakeMuse,
  removeTestFolders,
  writeFakeCredential,
} from './fakeMuse'

const TEST_TIMEOUT_MS = 30_000
// When the fake CLI sends its captured ending after loginStart.
const ENDING_AFTER_MS = 300
// "At once": well under the 30 s an unanswered account/read would take.
const PROMPT_MS = 5000
// A schema no build has written: only the CLI can say what it holds.
const UNPLACEABLE = '{"schema_version": 9, "providers": {"meta": {}}}'
const LOGOUT_SHELL = '{\n  "schema_version": 1,\n  "providers": {}\n}'

const fake = installFakeMuse()
const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'fake-muse-ws-'))
const configHome = installFakeCredential(UNPLACEABLE)
const managers: MuseCodeBackendManager[] = []

function setup(fakeEnvironment: readonly { name: string; value: string }[] = []) {
  const log = new FakeLogOutputChannel()
  const backend = new MuseCodeBackendManager({
    log,
    extensionVersion: '0.0.0-e2e',
    getConfiguredBinaryPath: () => fake.binaryPath,
    // The config home reaches both the CLI and the extension's own look at
    // the file through the documented setting, as a user's would.
    getEnvironmentVariables: () => [
      { name: 'MUSE_FAKE_NODE', value: process.execPath },
      { name: 'MUSE_FAKE_FINGERPRINT', value: EXPECTED_SCHEMA_FINGERPRINT },
      { name: 'XDG_CONFIG_HOME', value: configHome },
      ...fakeEnvironment,
    ],
    workspaceRoot,
    getShellSandbox: () => 'off',
    getSandboxNetwork: () => 'default',
    userProfileDir: undefined,
    isWorkspaceTrusted: () => true,
    getProxySettings: () => ({ proxy: '', noProxy: [] }),
  })
  managers.push(backend)
  const connect = () =>
    connectAccountSession(backend, '0.0.0-e2e', log, workspaceRoot, new AbortController().signal)
  const probe = vi.fn(() => probeAccount(connect, log))
  const account = new CliAccount({
    platform: process.platform,
    credentialFilePath: () => backend.credentialFilePath(),
    probe,
    log,
  })
  return { backend, log, connect, probe, account }
}

function everythingLogged(log: FakeLogOutputChannel): string {
  return [...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls].flat().join('\n')
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((created) => created.dispose()))
})

afterAll(() => {
  removeTestFolders([fake.installDir, workspaceRoot, configHome])
})

describe('The CLI’s sign-in against a real child process', { timeout: TEST_TIMEOUT_MS }, () => {
  it('asks the CLI once about a file it cannot place, then signs out through account/logout', async () => {
    writeFakeCredential(configHome, UNPLACEABLE)
    const t = setup()
    expect(t.backend.credentialFilePath()).toBe(fakeCredentialFile(configHome))
    await expect(t.account.signIn(true)).resolves.toBe('signedIn')
    await expect(t.account.signIn(false)).resolves.toBe('signedIn')
    expect(t.probe).toHaveBeenCalledOnce()

    await expect(logOutAccount(t.connect, t.log)).resolves.toBe('confirmed')
    // The file stays, emptied, as `muse logout` leaves it; its structure alone
    // now says signed out, and no host is started to say so.
    expect(readFileSync(fakeCredentialFile(configHome), 'utf8')).toBe(LOGOUT_SHELL)
    expect(readCredentialFile(t.backend.credentialFilePath(), process.platform)?.verdict).toBe(
      'empty',
    )
    await expect(t.account.signIn(true)).resolves.toBe('signedOut')
    expect(t.probe).toHaveBeenCalledOnce()
    expect(everythingLogged(t.log)).not.toContain('person@example.com')
  })

  it('reads a stored sign-in from the file alone', async () => {
    writeFakeCredential(configHome, FAKE_STORED_SIGN_IN)
    const t = setup()
    await expect(t.account.signIn(true)).resolves.toBe('signedIn')
    expect(t.probe).not.toHaveBeenCalled()
  })
})

/** A device sign-in from a signed-out home; `fakeEnvironment` scripts the fake CLI. */
function signIn(fakeEnvironment: readonly { name: string; value: string }[], signal: AbortSignal) {
  writeFakeCredential(configHome, LOGOUT_SHELL)
  const t = setup([{ name: 'MUSE_FAKE_CAPTURES', value: CAPTURES_FOLDER }, ...fakeEnvironment])
  const onCode = vi.fn()
  const outcome = runDeviceSignIn({
    connect: (flowSignal) =>
      connectAccountSession(t.backend, '0.0.0-e2e', t.log, workspaceRoot, flowSignal),
    credentialFileModifiedAt: () => statSync(t.backend.credentialFilePath()).mtimeMs,
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms)
      }),
    now: Date.now,
    signal,
    onCode,
    log: t.log,
  })
  return { ...t, onCode, outcome }
}

// The device sign-in against the fake CLI replaying the frames captured on
// 1.4.0-R4302.1 (test/fixtures/msp; PR #49 P1 and P2).
describe('The device sign-in against a real child process', { timeout: TEST_TIMEOUT_MS }, () => {
  it('ends on the captured expired ending, shown the code as captured', async () => {
    const t = signIn(
      [
        { name: 'MUSE_FAKE_LOGIN_ENDING', value: 'expired' },
        { name: 'MUSE_FAKE_LOGIN_ENDING_MS', value: String(ENDING_AFTER_MS) },
      ],
      new AbortController().signal,
    )
    await expect(t.outcome).resolves.toBe('expired')
    expect(t.onCode).toHaveBeenCalledWith(
      'https://auth.meta.com/oauth/device/?code=AAAA-AAAA',
      'AAAA-AAAA',
    )
    expect(t.log.info).toHaveBeenCalledWith(
      'Muse Code sign-in ended: expired: login failed: the request expired',
    )
  })

  it('ends at once on the host’s ending while account/read goes unanswered', async () => {
    const t = signIn(
      [
        { name: 'MUSE_FAKE_ACCOUNT_READ', value: 'silentAfterStart' },
        { name: 'MUSE_FAKE_LOGIN_ENDING', value: 'expired' },
        { name: 'MUSE_FAKE_LOGIN_ENDING_MS', value: String(ENDING_AFTER_MS) },
      ],
      new AbortController().signal,
    )
    const started = Date.now()
    await expect(t.outcome).resolves.toBe('expired')
    expect(Date.now() - started).toBeLessThan(PROMPT_MS)
  })

  it('cancels at once while account/read goes unanswered, and the CLI ends its flow', async () => {
    const abort = new AbortController()
    const t = signIn([{ name: 'MUSE_FAKE_ACCOUNT_READ', value: 'silentAfterStart' }], abort.signal)
    await vi.waitFor(
      () => {
        expect(t.onCode).toHaveBeenCalledOnce()
      },
      { timeout: TEST_TIMEOUT_MS },
    )
    const cancelled = Date.now()
    abort.abort()
    await expect(t.outcome).resolves.toBe('cancelled')
    expect(Date.now() - cancelled).toBeLessThan(PROMPT_MS)
    // The captured `cancelled` ending the fake sends before its answer.
    await vi.waitFor(() => {
      expect(t.log.info).toHaveBeenCalledWith('Muse Code sign-in ended: cancelled')
    })
  })
})
