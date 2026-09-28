import { describe, expect, it } from 'vitest'
import {
  credentialFileVerdict,
  keychainItemPresence,
} from '../../src/core/backends/musecode/credentialFile'

// The shapes Muse Code 1.3.0 and 1.4.0-R4302.1 wrote in isolated homes
// (2026-09-27), and the macOS pointer a third party observed on 1.3.0
// (aonia §2.3). No token in any of them: the values are placeholders.
const LOGOUT_SHELL = '{\n  "schema_version": 1,\n  "providers": {}\n}'
const STORED_KEY = JSON.stringify({
  schema_version: 1,
  providers: { meta: { mechanism: 'api_key', api_key: '<placeholder>' } },
})
const OAUTH_LOGIN = JSON.stringify({
  schema_version: 1,
  providers: {
    meta: {
      mechanism: 'oauth',
      obtained_via: 'device_code',
      oauth: { access_token: '<placeholder>', refresh_token: '<placeholder>', expires_at: 1 },
    },
  },
})
const MAC_POINTER = JSON.stringify({
  schema_version: 2,
  providers: {
    meta: {
      mechanism: 'oauth',
      storage: 'keychain',
      obtained_via: 'device_code',
      api_base_url: 'https://api.meta.ai/v1',
    },
  },
})
const SCHEMA_1_POINTER = JSON.stringify({
  schema_version: 1,
  providers: { meta: { storage: 'keychain' } },
})

describe('credentialFileVerdict', () => {
  it.each(['win32', 'linux', 'darwin'] as const)(
    'reads the file a sign-out leaves as empty on %s',
    (platform) => {
      expect(credentialFileVerdict(LOGOUT_SHELL, platform)).toBe('empty')
    },
  )

  it('reads a stored key or login as held in the file', () => {
    expect(credentialFileVerdict(STORED_KEY, 'win32')).toBe('inline')
    expect(credentialFileVerdict(OAUTH_LOGIN, 'linux')).toBe('inline')
    expect(credentialFileVerdict(OAUTH_LOGIN, 'darwin')).toBe('inline')
  })

  it('reads a macOS Keychain pointer as needing the CLI on macOS', () => {
    expect(credentialFileVerdict(MAC_POINTER, 'darwin')).toBe('keychain')
    expect(credentialFileVerdict(SCHEMA_1_POINTER, 'darwin')).toBe('keychain')
    expect(credentialFileVerdict('{"schema_version":2,"providers":{}}', 'darwin')).toBe('empty')
  })

  // Both made `muse serve` exit 3 on Windows 1.4.0 (isolated homes).
  it.each(['win32', 'linux'] as const)('names a Keychain pointer on %s', (platform) => {
    expect(credentialFileVerdict(MAC_POINTER, platform)).toBe('keychainElsewhere')
    expect(credentialFileVerdict(SCHEMA_1_POINTER, platform)).toBe('keychainElsewhere')
  })

  // A signed-out macOS file copied elsewhere names no provider, so points nowhere (the review of PR #49).
  it.each(['win32', 'linux'] as const)(
    'reads an empty version-2 file as signed out on %s',
    (platform) => {
      expect(credentialFileVerdict('{"schema_version":2,"providers":{}}', platform)).toBe('empty')
    },
  )

  it.each([
    ['not JSON', '{"schema_version": 1, "providers": '],
    ['a future schema', '{"schema_version": 3, "providers": {"meta": {}}}'],
    ['no providers', '{"schema_version": 1}'],
    ['a provider that is not an object', '{"schema_version": 1, "providers": {"meta": "x"}}'],
    ['a version that is not a number', '{"schema_version": "1", "providers": {}}'],
    ['an array', '[]'],
  ])('leaves %s to the CLI', (_name, text) => {
    expect(credentialFileVerdict(text, 'linux')).toBe('unrecognized')
  })
})

describe('keychainItemPresence', () => {
  it('reads the attribute lookup’s exit code', () => {
    expect(keychainItemPresence(0)).toBe('present')
    expect(keychainItemPresence(44)).toBe('absent')
    expect(keychainItemPresence(-1)).toBe('unknown')
    expect(keychainItemPresence(36)).toBe('unknown')
  })
})
