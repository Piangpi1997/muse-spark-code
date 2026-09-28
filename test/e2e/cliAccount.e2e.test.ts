// The CLI's sign-in against a real child process (PLAN.md D26): the real
// backend manager spawns the fake CLI (fake-muse/serve.mjs) as a short-lived
// experimental host, asks it `account/read` about a credential file whose
// structure cannot say, and signs out through `account/logout`, which leaves
// the file behind, emptied, as Muse Code does. No token is in any file.

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EXPECTED_SCHEMA_FINGERPRINT } from '@muse-code/sdk'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { connectAccountSession, logOutAccount, probeAccount } from '../../src/host/auth/accountHost'
import { CliAccount, readCredentialFile } from '../../src/host/auth/cliAccount'
import { MuseCodeBackendManager } from '../../src/host/backend/museCodeBackendManager'
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
// A schema no build has written: only the CLI can say what it holds.
const UNPLACEABLE = '{"schema_version": 9, "providers": {"meta": {}}}'
const LOGOUT_SHELL = '{\n  "schema_version": 1,\n  "providers": {}\n}'

const fake = installFakeMuse()
const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'fake-muse-ws-'))
const configHome = installFakeCredential(UNPLACEABLE)
const managers: MuseCodeBackendManager[] = []

function setup() {
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
