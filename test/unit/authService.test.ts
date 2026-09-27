import { describe, expect, it, vi } from 'vitest'
import { AuthService, type AuthServiceDeps } from '../../src/host/auth/authService'
import { CredentialStore } from '../../src/host/auth/credentialStore'
import { MUSE_INSTALL_TIMEOUT_MS, type BackendMode } from '../../src/shared/constants'
import type { HostToWebviewMessage } from '../../src/shared/protocol'
import { FakeLogOutputChannel, memorySecrets, unexpectedWarning } from './helpers/fakes'

const CREDENTIAL_MTIME = 5000

interface Harness {
  readonly service: AuthService
  readonly deps: AuthServiceDeps
  readonly broadcasts: HostToWebviewMessage[]
  readonly facts: {
    cliPresent: boolean
    credentialFile: boolean
    credentialMtime: number
    envKey: boolean
    backendMode: BackendMode
  }
  readonly restartBackend: ReturnType<
    typeof vi.fn<(isConversationEnding: boolean) => Promise<void>>
  >
  readonly runInTerminal: ReturnType<
    typeof vi.fn<(cliPath: string, args: readonly string[]) => void>
  >
  readonly runDeviceSignIn: ReturnType<
    typeof vi.fn<
      (
        signal: AbortSignal,
        onCode: (url: string, code: string) => void,
      ) => Promise<'signedIn' | 'cancelled' | 'timedOut'>
    >
  >
  readonly runInstallerInTerminal: ReturnType<typeof vi.fn<() => void>>
  readonly logoutHoldState: { isHeld: boolean }
}

function harness(overrides: Partial<AuthServiceDeps> = {}): Harness {
  const broadcasts: HostToWebviewMessage[] = []
  const facts = {
    cliPresent: true,
    credentialFile: false,
    credentialMtime: CREDENTIAL_MTIME,
    envKey: false,
    backendMode: 'auto' as BackendMode,
  }
  const restartBackend = vi.fn<(isConversationEnding: boolean) => Promise<void>>(() =>
    Promise.resolve(),
  )
  const runInTerminal = vi.fn<(cliPath: string, args: readonly string[]) => void>()
  const runDeviceSignIn = vi.fn<
    (
      signal: AbortSignal,
      onCode: (url: string, code: string) => void,
    ) => Promise<'signedIn' | 'cancelled' | 'timedOut'>
  >(() => Promise.resolve('timedOut'))
  const runInstallerInTerminal = vi.fn<() => void>()
  const logoutHoldState = { isHeld: false }
  let clock = 0
  const deps: AuthServiceDeps = {
    backend: {
      resolveCli: () =>
        facts.cliPresent ? { ok: true, cliPath: '/bin/muse' } : { ok: false, reason: 'missing' },
      credentialFileExists: () => facts.credentialFile,
      // A written file has a new stamp; the harness writes it once.
      credentialFileModifiedAt: () => (facts.credentialFile ? facts.credentialMtime : undefined),
      hasEnvironmentKey: () => facts.envKey,
      getBackendMode: () => facts.backendMode,
      restartBackend,
    },
    credentials: new CredentialStore(memorySecrets(), unexpectedWarning),
    runInTerminal,
    installCommand: 'irm https://dev.meta.ai/install.ps1 | iex',
    runInstallerInTerminal,
    logoutHold: {
      get: () => logoutHoldState.isHeld,
      set: (isHeld: boolean) => {
        logoutHoldState.isHeld = isHeld
        return Promise.resolve()
      },
    },
    runDeviceSignIn,
    promptForApiKey: vi.fn(() => Promise.resolve('LLM|1|secret')),
    broadcast: (message) => {
      broadcasts.push(message)
    },
    sleep: (ms) => {
      clock += ms
      return Promise.resolve()
    },
    now: () => clock,
    log: new FakeLogOutputChannel(),
    ...overrides,
  }
  return {
    service: new AuthService(deps),
    deps,
    broadcasts,
    facts,
    restartBackend,
    runInTerminal,
    runDeviceSignIn,
    runInstallerInTerminal,
    logoutHoldState,
  }
}

async function signedInModelApi(overrides: Partial<AuthServiceDeps> = {}): Promise<Harness> {
  const h = harness(overrides)
  await h.deps.credentials.setApiKey('LLM|1|secret')
  await h.service.refresh()
  return h
}

async function expectSignedOutWithoutKey(h: Harness): Promise<void> {
  expect(await h.deps.credentials.getApiKey()).toBeUndefined()
  expect(h.service.current.status).toBe('signedOut')
  expect(h.broadcasts).not.toContainEqual(
    expect.objectContaining({ type: 'authState', status: 'signedIn' }),
  )
}

describe('AuthService.refresh', () => {
  it('reports noCli with the reason when the CLI is missing, offering the key path', async () => {
    const h = harness()
    h.facts.cliPresent = false
    await expect(h.service.refresh()).resolves.toEqual({
      status: 'noCli',
      detail: 'missing',
      backend: undefined,
      methods: ['apiKey'],
      hasCli: false,
      hasCliSession: false,
    })
    expect(h.broadcasts.at(-1)).toEqual({
      type: 'authState',
      status: 'noCli',
      detail: 'missing',
      methods: ['apiKey'],
      installCommand: 'irm https://dev.meta.ai/install.ps1 | iex',
      hasCli: false,
      hasCliSession: false,
    })
    expect(h.service.backend).toBeUndefined()
  })

  it('derives signed out / signed in from the CLI credential facts, on the Muse Code backend', async () => {
    const h = harness()
    await expect(h.service.refresh()).resolves.toMatchObject({
      status: 'signedOut',
      backend: 'museCode',
      methods: ['browser', 'apiKey'],
    })
    h.facts.credentialFile = true
    await expect(h.service.refresh()).resolves.toMatchObject({ status: 'signedIn' })
    expect(h.broadcasts.at(-1)).toEqual({
      type: 'authState',
      status: 'signedIn',
      backend: 'museCode',
      methods: ['browser', 'apiKey'],
      installCommand: 'irm https://dev.meta.ai/install.ps1 | iex',
      hasCli: true,
      hasCliSession: true,
    })
    expect(h.service.backend).toBe('museCode')
  })

  it('takes the Model API backend from a stored key when the CLI has no session, and never mixes them', async () => {
    const h = harness()
    h.facts.cliPresent = false
    await h.deps.credentials.setApiKey('LLM|1|secret')
    await expect(h.service.refresh()).resolves.toMatchObject({
      status: 'signedIn',
      backend: 'modelApi',
    })
    // A CLI session takes precedence in auto: the subscription pays for CLI work.
    h.facts.cliPresent = true
    h.facts.credentialFile = true
    await expect(h.service.refresh()).resolves.toMatchObject({
      status: 'signedIn',
      backend: 'museCode',
    })
    // Forced modes.
    h.facts.backendMode = 'modelApi'
    await expect(h.service.refresh()).resolves.toMatchObject({
      status: 'signedIn',
      backend: 'modelApi',
      methods: ['apiKey'],
    })
    h.facts.backendMode = 'museCode'
    h.facts.credentialFile = false
    await expect(h.service.refresh()).resolves.toMatchObject({
      status: 'signedOut',
      backend: 'museCode',
      methods: ['browser'],
    })
    h.facts.cliPresent = false
    await expect(h.service.refresh()).resolves.toMatchObject({ status: 'noCli', methods: [] })
  })
})

describe('AuthService.signIn', () => {
  it.each(['cancelled', 'timedOut'] as const)(
    'keeps a valid Model API session after CLI device sign-in is %s',
    async (outcome) => {
      const h = await signedInModelApi()
      h.runDeviceSignIn.mockResolvedValue(outcome)
      await expect(h.service.signIn('browser')).resolves.toMatchObject({
        status: 'signedIn',
        backend: 'modelApi',
      })
      expect(await h.deps.credentials.getApiKey()).toBe('LLM|1|secret')
      expect(h.restartBackend).not.toHaveBeenCalled()
      expect(h.broadcasts).toContainEqual(
        expect.objectContaining({ type: 'notice', text: expect.any(String) }),
      )
    },
  )

  it('keeps a valid Model API session when the temporary CLI host fails', async () => {
    const h = await signedInModelApi()
    h.runDeviceSignIn.mockRejectedValue(new Error('handshake failed'))
    await expect(h.service.signIn('browser')).resolves.toMatchObject({
      status: 'signedIn',
      backend: 'modelApi',
    })
    expect(h.restartBackend).not.toHaveBeenCalled()
    expect(h.broadcasts).toContainEqual(
      expect.objectContaining({ type: 'notice', level: 'warning' }),
    )
  })

  it('keeps the Model API session when Muse Code disappears before sign-in starts', async () => {
    const h = await signedInModelApi()
    h.facts.cliPresent = false
    await expect(h.service.signIn('browser')).resolves.toMatchObject({
      status: 'signedIn',
      backend: 'modelApi',
      hasCli: false,
    })
    expect(h.runDeviceSignIn).not.toHaveBeenCalled()
  })

  it('does not publish a device code after the user cancels sign-in', async () => {
    const h = harness()
    let publishCode: ((url: string, code: string) => void) | undefined
    const login = Promise.withResolvers<'cancelled'>()
    h.runDeviceSignIn.mockImplementation((_signal, onCode) => {
      publishCode = onCode
      return login.promise
    })
    const pending = h.service.signIn('browser')
    h.service.cancelSignIn()
    publishCode?.('https://auth.meta.com/oauth/device/', 'ABCD-EFGH')
    login.resolve('cancelled')
    await pending
    expect(
      h.broadcasts.some((message) => message.type === 'authState' && 'userCode' in message),
    ).toBe(false)
  })

  it('shows the device code, waits for the credential, and restarts the backend', async () => {
    const h = harness()
    h.runDeviceSignIn.mockImplementation((_signal, onCode) => {
      onCode('https://auth.meta.com/oauth/device/', 'ABCD-EFGH')
      h.facts.credentialFile = true
      return Promise.resolve('signedIn')
    })
    await expect(h.service.signIn('browser')).resolves.toMatchObject({ status: 'signedIn' })
    expect(h.runInTerminal).not.toHaveBeenCalled()
    expect(h.broadcasts).toContainEqual(
      expect.objectContaining({ type: 'authState', userCode: 'ABCD-EFGH' }),
    )
    expect(
      h.broadcasts.map((message) => (message.type === 'authState' ? message.status : '')),
    ).toEqual(['signingIn', 'signingIn', 'signedIn'])
    expect(h.restartBackend).toHaveBeenCalledOnce()
  })

  it('reports a timed-out browser sign-in as signed out with a detail', async () => {
    const h = harness()
    await expect(h.service.signIn('browser')).resolves.toMatchObject({
      status: 'signedOut',
      detail: 'The sign-in did not complete in time. Try again.',
    })
    expect(h.restartBackend).not.toHaveBeenCalled()
  })

  it('stores a pasted API key, restarts the backends and lands on the Model API backend', async () => {
    const h = harness()
    await expect(h.service.signIn('apiKey')).resolves.toMatchObject({
      status: 'signedIn',
      backend: 'modelApi',
    })
    await expect(h.deps.credentials.getApiKey()).resolves.toBe('LLM|1|secret')
    expect(h.restartBackend).toHaveBeenCalledOnce()
  })

  it('revokes host admission during a same-kind Model API key replacement', async () => {
    const h = await signedInModelApi({
      promptForApiKey: () => Promise.resolve('LLM|1|replacement'),
    })
    const priorGeneration = h.service.admissionGeneration
    const stored = Promise.withResolvers<undefined>()
    const originalStore = h.deps.credentials.setApiKey.bind(h.deps.credentials)
    const writing = vi
      .spyOn(h.deps.credentials, 'setApiKey')
      .mockImplementationOnce(async (key) => {
        await stored.promise
        await originalStore(key)
      })
    const replacing = h.service.signIn('apiKey')
    await vi.waitFor(() => {
      expect(writing).toHaveBeenCalledOnce()
    })
    expect(h.service.backend).toBeUndefined()
    expect(h.service.admissionGeneration).toBeGreaterThan(priorGeneration)
    stored.resolve(undefined)
    await replacing
    expect(h.service.backend).toBe('modelApi')
    expect(h.restartBackend).toHaveBeenLastCalledWith(true)
  })

  it('stops the old account before storing the replacement key', async () => {
    const h = await signedInModelApi({
      promptForApiKey: () => Promise.resolve('LLM|1|replacement'),
    })
    const stopStarted = Promise.withResolvers<undefined>()
    const finishStop = Promise.withResolvers<undefined>()
    h.restartBackend.mockImplementation(async () => {
      stopStarted.resolve(undefined)
      await finishStop.promise
    })
    const replacing = h.service.signIn('apiKey')
    await stopStarted.promise
    expect(await h.deps.credentials.getApiKey()).toBe('LLM|1|secret')
    finishStop.resolve(undefined)
    await replacing
    expect(await h.deps.credentials.getApiKey()).toBe('LLM|1|replacement')
  })

  it('accepts an API key without the CLI', async () => {
    const h = harness()
    h.facts.cliPresent = false
    await expect(h.service.signIn('apiKey')).resolves.toMatchObject({
      status: 'signedIn',
      backend: 'modelApi',
    })
    expect(h.runDeviceSignIn).not.toHaveBeenCalled()
  })

  it('leaves the state alone when the key prompt is dismissed', async () => {
    const h = harness({ promptForApiKey: vi.fn(() => Promise.resolve(undefined)) })
    await h.service.refresh()
    await expect(h.service.signIn('apiKey')).resolves.toMatchObject({ status: 'signedOut' })
    expect(h.restartBackend).not.toHaveBeenCalled()
  })

  it('does not restore a Model API key from a prompt completed after sign-out', async () => {
    const prompt = Promise.withResolvers<string>()
    const h = harness({ promptForApiKey: () => prompt.promise })
    const signingIn = h.service.signIn('apiKey')
    await h.service.signOut()
    prompt.resolve('LLM|1|late')
    await signingIn
    await expectSignedOutWithoutKey(h)
  })

  it('waits for an in-flight SecretStorage write before clearing the key at sign-out', async () => {
    const storeStarted = Promise.withResolvers<undefined>()
    const finishStore = Promise.withResolvers<undefined>()
    const secrets = memorySecrets()
    const credentials = new CredentialStore(
      {
        get: secrets.get,
        store: async (key, value) => {
          storeStarted.resolve(undefined)
          await finishStore.promise
          secrets.values.set(key, value)
        },
        delete: secrets.delete,
      },
      unexpectedWarning,
    )
    const h = harness({ credentials })
    const signingIn = h.service.signIn('apiKey')
    await storeStarted.promise
    const signingOut = h.service.signOut()
    finishStore.resolve(undefined)
    await Promise.all([signingIn, signingOut])
    await expectSignedOutWithoutKey(h)
  })

  it('stops the backend after a key sign-in restart already underway', async () => {
    const restartStarted = Promise.withResolvers<undefined>()
    const finishSignInRestart = Promise.withResolvers<undefined>()
    const h = harness()
    let isHostActive = false
    h.restartBackend.mockImplementation(async (isConversationEnding) => {
      if (isConversationEnding) {
        isHostActive = false
        return
      }
      restartStarted.resolve(undefined)
      await finishSignInRestart.promise
      isHostActive = true
    })
    const signingIn = h.service.signIn('apiKey')
    await restartStarted.promise
    const signingOut = h.service.signOut()
    await new Promise((resolve) => setTimeout(resolve, 0))
    finishSignInRestart.resolve(undefined)
    await Promise.all([signingIn, signingOut])
    await expectSignedOutWithoutKey(h)
    expect(isHostActive).toBe(false)
  })

  it('starts one device flow however often the button is pressed (D25)', async () => {
    const h = harness()
    h.runDeviceSignIn.mockImplementation(() => {
      h.facts.credentialFile = true
      return Promise.resolve('signedIn')
    })
    const first = h.service.signIn('browser')
    const second = h.service.signIn('browser')
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { status: 'signedIn' },
      { status: 'signedIn' },
    ])
    expect(h.runDeviceSignIn).toHaveBeenCalledOnce()
  })

  it('refuses the browser sign-in when the CLI is missing', async () => {
    const h = harness()
    h.facts.cliPresent = false
    await expect(h.service.signIn('browser')).resolves.toMatchObject({ status: 'noCli' })
    expect(h.runDeviceSignIn).not.toHaveBeenCalled()
  })

  it('cancels the running device flow without changing credentials', async () => {
    const h = harness()
    h.runDeviceSignIn.mockImplementation(
      (signal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              resolve('cancelled')
            },
            { once: true },
          )
        }),
    )
    const pending = h.service.signIn('browser')
    h.service.cancelSignIn()
    await expect(pending).resolves.toMatchObject({
      status: 'signedOut',
      detail: 'Sign-in cancelled.',
    })
    expect(h.restartBackend).not.toHaveBeenCalled()
  })
})

describe('AuthService.installMuseCode', () => {
  it('reports terminal launch failure without signing out a Model API session', async () => {
    const h = await signedInModelApi()
    h.facts.cliPresent = false
    h.runInstallerInTerminal.mockImplementation(() => {
      throw new Error('terminal unavailable')
    })
    await expect(h.service.installMuseCode()).resolves.toMatchObject({
      status: 'signedIn',
      backend: 'modelApi',
      installState: 'failed',
      detail: 'The installer terminal could not open. Try again or use the install instructions.',
    })
    expect(h.broadcasts).toContainEqual(
      expect.objectContaining({ type: 'notice', level: 'warning' }),
    )
    expect(h.restartBackend).not.toHaveBeenCalled()
  })

  it('does not restore an old Model API session when install times out after sign-out', async () => {
    let clock = 0
    const poll = Promise.withResolvers<undefined>()
    const h = harness({
      now: () => clock,
      sleep: () => poll.promise,
    })
    h.facts.cliPresent = false
    await h.deps.credentials.setApiKey('LLM|1|secret')
    await h.service.refresh()
    const pending = h.service.installMuseCode()
    expect(h.runInstallerInTerminal).toHaveBeenCalledOnce()
    await h.service.signOut()
    clock = MUSE_INSTALL_TIMEOUT_MS
    poll.resolve(undefined)
    await pending
    expect(await h.deps.credentials.getApiKey()).toBeUndefined()
    expect(h.service.current.status).not.toBe('signedIn')
  })

  it('does not restore a signed-in state when the installer fails during sign-out', async () => {
    let clock = 0
    const poll = Promise.withResolvers<undefined>()
    const stopping = Promise.withResolvers<undefined>()
    const h = await signedInModelApi({
      now: () => clock,
      sleep: () => poll.promise,
    })
    h.facts.cliPresent = false
    h.restartBackend.mockImplementation(() => stopping.promise)

    const installing = h.service.installMuseCode()
    const signingOut = h.service.signOut()
    clock = MUSE_INSTALL_TIMEOUT_MS
    poll.resolve(undefined)
    const installResult = await installing
    const visibleDuringSignOut = h.service.current.status
    stopping.resolve(undefined)
    await signingOut

    expect(installResult.status).not.toBe('signedIn')
    expect(visibleDuringSignOut).not.toBe('signedIn')
  })

  it('keeps a logout hold when an installer terminal fails after the CLI appears', async () => {
    const h = harness()
    h.facts.cliPresent = false
    h.facts.envKey = true
    await h.service.refresh()
    await h.service.signOut()
    h.runInstallerInTerminal.mockImplementation(() => {
      h.facts.cliPresent = true
      throw new Error('terminal unavailable')
    })

    const result = await h.service.installMuseCode()
    expect(result.status).not.toBe('signedIn')
    expect(h.service.backend).toBeUndefined()
    expect(h.logoutHoldState.isHeld).toBe(true)
  })

  it('does not open an installer terminal after sign-out has started', async () => {
    const stopping = Promise.withResolvers<undefined>()
    const h = harness()
    h.facts.cliPresent = false
    h.restartBackend.mockImplementation(() => stopping.promise)

    const signingOut = h.service.signOut()
    const result = await h.service.installMuseCode()
    stopping.resolve(undefined)
    await signingOut

    expect(result.status).not.toBe('signedIn')
    expect(h.runInstallerInTerminal).not.toHaveBeenCalled()
  })

  it('keeps a signed-in Model API session while watching a CLI install', async () => {
    const h = harness()
    h.facts.cliPresent = false
    await h.deps.credentials.setApiKey('LLM|1|secret')
    await h.service.refresh()
    h.runInstallerInTerminal.mockImplementation(() => {
      h.facts.cliPresent = true
    })
    await h.service.installMuseCode()
    expect(h.broadcasts).toContainEqual(
      expect.objectContaining({
        type: 'authState',
        status: 'signedIn',
        backend: 'modelApi',
        installState: 'running',
      }),
    )
    expect(h.service.current).toMatchObject({
      status: 'signedIn',
      backend: 'modelApi',
      hasCli: true,
    })
    expect(h.restartBackend).not.toHaveBeenCalled()
  })

  it('keeps Model API signed in when the CLI install times out', async () => {
    const h = harness()
    h.facts.cliPresent = false
    await h.deps.credentials.setApiKey('LLM|1|secret')
    await h.service.refresh()
    await expect(h.service.installMuseCode()).resolves.toMatchObject({
      status: 'signedIn',
      backend: 'modelApi',
      installState: 'failed',
      hasCli: false,
    })
    expect(h.restartBackend).not.toHaveBeenCalled()
  })

  it('stores a secondary key without restarting a signed-in Muse Code session', async () => {
    const h = harness()
    h.facts.credentialFile = true
    await h.service.refresh()
    await h.service.signIn('apiKey')
    expect(h.service.current).toMatchObject({ status: 'signedIn', backend: 'museCode' })
    expect(await h.deps.credentials.getApiKey()).toBe('LLM|1|secret')
    expect(h.restartBackend).not.toHaveBeenCalled()
  })

  it('retires an active Model API session before auto-selecting the newly installed CLI', async () => {
    const h = await signedInModelApi()
    h.facts.cliPresent = false
    h.runInstallerInTerminal.mockImplementation(() => {
      h.facts.cliPresent = true
      h.facts.credentialFile = true
    })
    const selected = await h.service.installMuseCode()
    expect(selected).toMatchObject({ status: 'signedIn', backend: 'museCode' })
    expect(h.restartBackend).toHaveBeenCalledWith(true)
  })

  it('retires the active Model API session when the CLI appeared before Install was pressed', async () => {
    const h = await signedInModelApi()
    h.facts.cliPresent = true
    h.facts.credentialFile = true
    const selected = await h.service.installMuseCode()
    expect(selected).toMatchObject({ status: 'signedIn', backend: 'museCode' })
    expect(h.restartBackend).toHaveBeenCalledWith(true)
    expect(h.runInstallerInTerminal).not.toHaveBeenCalled()
  })

  it('keeps admission closed if the old host cannot stop during installer auto-switch', async () => {
    const h = await signedInModelApi()
    h.facts.cliPresent = false
    h.runInstallerInTerminal.mockImplementation(() => {
      h.facts.cliPresent = true
      h.facts.credentialFile = true
    })
    h.restartBackend.mockRejectedValue(new Error('cannot stop'))
    const selected = await h.service.installMuseCode()
    expect(selected.status).toBe('error')
    expect(h.service.backend).toBeUndefined()
  })

  it('replaces the secondary key without ending the signed-in Muse Code session', async () => {
    const h = harness({ promptForApiKey: () => Promise.resolve('LLM|1|replacement') })
    h.facts.credentialFile = true
    await h.deps.credentials.setApiKey('LLM|1|secret')
    await h.service.refresh()
    await h.service.signIn('apiKey')
    expect(await h.deps.credentials.getApiKey()).toBe('LLM|1|replacement')
    expect(h.service.current).toMatchObject({ status: 'signedIn', backend: 'museCode' })
    expect(h.restartBackend).not.toHaveBeenCalled()
  })

  it('opens one installer terminal and notices the CLI', async () => {
    const h = harness()
    h.facts.cliPresent = false
    h.runInstallerInTerminal.mockImplementation(() => {
      h.facts.cliPresent = true
    })
    const first = h.service.installMuseCode()
    const second = h.service.installMuseCode()
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { status: 'signedOut' },
      { status: 'signedOut' },
    ])
    expect(h.runInstallerInTerminal).toHaveBeenCalledOnce()
    expect(
      h.broadcasts.some(
        (message) => message.type === 'authState' && message.status === 'installing',
      ),
    ).toBe(true)
  })

  it('does not run an installer when the CLI is already present', async () => {
    const h = harness()
    await h.service.installMuseCode()
    expect(h.runInstallerInTerminal).not.toHaveBeenCalled()
  })
})

describe('AuthService.signOut and host reports', () => {
  it('keeps admission closed while two panels sign out and one stop is held', async () => {
    const h = await signedInModelApi()
    const heldStop = Promise.withResolvers<undefined>()
    let stops = 0
    h.restartBackend.mockImplementation((isEnding) =>
      isEnding && ++stops === 1 ? heldStop.promise : Promise.resolve(),
    )
    const firstPanel = h.service.signOut()
    const secondPanel = h.service.signOut()
    await new Promise<undefined>((resolve) => {
      setImmediate(() => {
        resolve(undefined)
      })
    })
    await h.service.signIn('apiKey')
    const admittedDuringSignOut = h.service.backend
    heldStop.resolve(undefined)
    await Promise.allSettled([firstPanel, secondPanel])
    expect(admittedDuringSignOut).toBeUndefined()
    expect(await h.deps.credentials.getApiKey()).toBeUndefined()
  })

  it('does not start an old browser click after a newer sign-out', async () => {
    const delayedRead = Promise.withResolvers<string | undefined>()
    const secrets = memorySecrets()
    let isNextReadDelayed = false
    const credentials = new CredentialStore(
      {
        get: (key) => {
          if (isNextReadDelayed) {
            isNextReadDelayed = false
            return delayedRead.promise
          }
          return secrets.get(key)
        },
        store: secrets.store,
        delete: secrets.delete,
      },
      unexpectedWarning,
    )
    const h = harness({ credentials })
    h.facts.credentialFile = true
    await h.service.refresh()
    await h.service.signOut()

    isNextReadDelayed = true
    const staleClick = h.service.signIn('browser')
    await h.service.signOut()
    delayedRead.resolve(undefined)
    await staleClick

    expect(h.runDeviceSignIn).not.toHaveBeenCalled()
    expect(h.logoutHoldState.isHeld).toBe(true)
  })

  it('recovers a held old CLI file through an explicit fresh device approval', async () => {
    const h = harness()
    h.facts.credentialFile = true
    await h.service.refresh()
    await h.service.signOut()
    h.runDeviceSignIn.mockImplementation(() => {
      h.facts.credentialMtime += 1
      return Promise.resolve('signedIn')
    })
    await expect(h.service.signIn('browser')).resolves.toMatchObject({
      status: 'signedIn',
      backend: 'museCode',
    })
    expect(h.runDeviceSignIn).toHaveBeenCalledOnce()
    expect(h.logoutHoldState.isHeld).toBe(false)
  })

  it('keeps the hold when a device runner reports success without a new credential write', async () => {
    const h = harness()
    h.facts.credentialFile = true
    await h.service.refresh()
    await h.service.signOut()
    h.runDeviceSignIn.mockResolvedValue('signedIn')
    await expect(h.service.signIn('browser')).resolves.toMatchObject({ status: 'error' })
    expect(h.runDeviceSignIn).toHaveBeenCalledOnce()
    expect(h.logoutHoldState.isHeld).toBe(true)
    expect(h.restartBackend.mock.calls).toEqual([[true]])
  })

  it('gates auth and starts ending sessions before hold persistence settles', async () => {
    const saving = Promise.withResolvers<undefined>()
    const h = harness({
      logoutHold: {
        get: () => false,
        set: (isHeld) => (isHeld ? saving.promise : Promise.resolve()),
      },
    })
    h.facts.credentialFile = true
    await h.service.refresh()
    const ending = h.service.signOut()
    expect(h.service.current.status).toBe('error')
    expect(h.service.backend).toBeUndefined()
    expect(h.restartBackend).toHaveBeenCalledWith(true)
    saving.resolve(undefined)
    await ending
  })

  it('still ends the host and reports an error when SecretStorage key deletion fails', async () => {
    const secrets = memorySecrets()
    const credentials = new CredentialStore(
      {
        get: secrets.get,
        store: secrets.store,
        delete: () => Promise.reject(new Error('keyring unavailable')),
      },
      unexpectedWarning,
    )
    const h = harness({ credentials })
    h.facts.credentialFile = true
    await credentials.setApiKey('LLM|1|secret')
    await h.service.refresh()
    await expect(h.service.signOut()).resolves.toMatchObject({
      status: 'error',
      detail: expect.stringContaining('Model API key'),
    })
    expect(h.restartBackend).toHaveBeenCalledWith(true)
    expect(h.service.backend).toBeUndefined()
  })

  it('ends the host and clears the key when the CLI logout terminal cannot open', async () => {
    const h = harness()
    h.facts.credentialFile = true
    await h.deps.credentials.setApiKey('LLM|1|secret')
    await h.service.refresh()
    h.runInTerminal.mockImplementation(() => {
      throw new Error('terminal unavailable')
    })
    await expect(h.service.signOut()).resolves.toMatchObject({
      status: 'signedOut',
      detail: expect.stringContaining('terminal'),
    })
    expect(h.restartBackend).toHaveBeenCalledWith(true)
    expect(await h.deps.credentials.getApiKey()).toBeUndefined()
    await expect(h.service.refresh()).resolves.toMatchObject({ status: 'error' })
  })

  it('keeps an environment-authenticated CLI gated until its key is removed', async () => {
    const h = harness()
    h.facts.envKey = true
    await h.service.refresh()
    await expect(h.service.signOut()).resolves.toMatchObject({
      status: 'signedOut',
      detail: expect.stringContaining('META_API_KEY'),
    })
    expect(h.runInTerminal).not.toHaveBeenCalled()
    await expect(h.service.refresh()).resolves.toMatchObject({
      status: 'error',
      detail: expect.stringContaining('META_API_KEY'),
    })
    expect(h.service.backend).toBeUndefined()
    h.facts.envKey = false
    await expect(h.service.refresh()).resolves.toMatchObject({
      status: 'signedOut',
      detail: undefined,
    })
  })

  it('does not reassert CLI sign-in while terminal logout still has the credential file', async () => {
    const h = harness()
    h.facts.credentialFile = true
    await h.service.refresh()
    await h.service.signOut()
    await expect(h.service.refresh()).resolves.toMatchObject({ status: 'error' })
    h.facts.credentialFile = false
    await expect(h.service.refresh()).resolves.toMatchObject({ status: 'signedOut' })
  })

  it('does not publish a stale signed-in choice when the held CLI key disappears during refresh', async () => {
    const pendingRead = Promise.withResolvers<string | undefined>()
    const secrets = memorySecrets()
    let isReadDelayed = false
    const credentials = new CredentialStore(
      {
        get: (key) => (isReadDelayed ? pendingRead.promise : secrets.get(key)),
        store: secrets.store,
        delete: secrets.delete,
      },
      unexpectedWarning,
    )
    const h = harness({ credentials })
    h.facts.envKey = true
    await h.service.refresh()
    await h.service.signOut()
    isReadDelayed = true
    const refreshing = h.service.refresh()
    h.facts.envKey = false
    pendingRead.resolve(undefined)
    await expect(refreshing).resolves.toMatchObject({ status: 'signedOut' })
    expect(h.service.backend).toBeUndefined()
  })

  it('keeps the logout hold across a new AuthService using the same stored state', async () => {
    const h = harness()
    h.facts.envKey = true
    await h.service.refresh()
    await h.service.signOut()
    expect(h.logoutHoldState.isHeld).toBe(true)
    const reactivated = new AuthService(h.deps)
    await expect(reactivated.refresh()).resolves.toMatchObject({ status: 'error' })
    h.facts.envKey = false
    await expect(reactivated.refresh()).resolves.toMatchObject({ status: 'signedOut' })
    expect(h.logoutHoldState.isHeld).toBe(false)
  })

  it('closes the host and reports an error when the logout hold cannot be persisted', async () => {
    const h = harness({
      logoutHold: {
        get: () => false,
        set: () => Promise.reject(new Error('state storage unavailable')),
      },
    })
    h.facts.envKey = true
    await h.service.refresh()
    await expect(h.service.signOut()).resolves.toMatchObject({
      status: 'error',
      detail: expect.stringContaining('save'),
    })
    expect(h.restartBackend).toHaveBeenCalledWith(true)
    expect(h.service.backend).toBeUndefined()
  })

  it('does not let browser approval reuse a still-present pay-as-you-go environment key', async () => {
    const h = harness()
    h.facts.envKey = true
    await h.service.refresh()
    await h.service.signOut()
    h.runDeviceSignIn.mockImplementation(() => {
      h.facts.credentialFile = true
      return Promise.resolve('signedIn')
    })
    await expect(h.service.signIn('browser')).resolves.toMatchObject({
      status: 'error',
      detail: expect.stringContaining('META_API_KEY'),
    })
    expect(h.restartBackend.mock.calls).toEqual([[true]])
    expect(h.logoutHoldState.isHeld).toBe(true)
  })

  it('clears the key, logs the CLI out when it holds a session, and restarts', async () => {
    const h = harness()
    await h.service.signIn('apiKey')
    h.facts.credentialFile = true
    await expect(h.service.signOut()).resolves.toMatchObject({ status: 'signedOut' })
    await expect(h.deps.credentials.getApiKey()).resolves.toBeUndefined()
    expect(h.runInTerminal).toHaveBeenLastCalledWith('/bin/muse', ['logout'])
    expect(h.restartBackend).toHaveBeenCalledTimes(2)
    // A sign-in keeps the conversations; a sign-out ends them (D25).
    expect(h.restartBackend.mock.calls).toEqual([[false], [true]])
  })

  it('does not run muse logout when there is no CLI session to end', async () => {
    const h = harness()
    await h.service.signOut()
    expect(h.runInTerminal).not.toHaveBeenCalled()
  })

  it('accepts the host verdict over its own estimate', async () => {
    const h = harness()
    h.facts.credentialFile = true
    await h.service.refresh()
    expect(h.service.markAuthRequired('not logged in')).toMatchObject({
      status: 'signedOut',
      detail: 'not logged in',
      backend: 'museCode',
    })
    expect(h.service.markBackendError('crashed')).toMatchObject({
      status: 'error',
      detail: 'crashed',
    })
    expect(h.service.toMessage()).toEqual({
      type: 'authState',
      status: 'error',
      detail: 'crashed',
      backend: 'museCode',
      methods: ['browser', 'apiKey'],
      installCommand: 'irm https://dev.meta.ai/install.ps1 | iex',
      hasCli: true,
      hasCliSession: true,
    })
  })
})
