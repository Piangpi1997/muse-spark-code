# Sign-in detection — the CLI's sign-in is read, not assumed (PLAN.md D26 amendment)

Recorded 2026-09-27, branch `fix/cli-sign-in-detection`.

## The finding

The extension took "Muse Code CLI signed in" to mean "`auth.json` exists".

- **What `muse logout` does.** It never deletes the file. It rewrites it
  as the 44-byte `{"schema_version": 1, "providers": {}}`.
- **Where that was seen.** Muse Code 1.3.0 on Linux, and 1.4.0-R4302.1 on
  Windows and Linux. Each run used an isolated home with a dummy stored
  key and a dead proxy.
- **What it broke.** After any sign-out the auto backend kept choosing
  Muse Code. A panel sign-out stayed on "Sign-out is in progress or
  credentials remain" until a new browser sign-in.
- **Why no test caught it.** The unit test "does not reassert CLI sign-in
  while terminal logout still has the credential file" modelled the logout
  as deleting the file.
- **macOS.** A sign-in is a login Keychain item (`ai.meta.dev.credentials`,
  account `meta`), and `auth.json` is a token-free pointer
  (`schema_version: 2`, `storage: "keychain"`).

The evidence is `scratchpad/muse-1.4.0-credentials.md`, with its probes
under `scratchpad/m140cred/`:

- `probe-logout-iso*.json`: the file after `muse logout`, on three builds;
- `probe-account-logout-iso.json`: MSP `account/logout` returns
  `{state:"loggedOut", credentialRequired:true}` in 10 ms, leaves the same
  file, and fires `account/changed`. A terminal logout fired nothing
  within 6 s;
- `probe-account-{win,mac,linux}.json`: the `account/read` shapes;
- `ptr-stderr.txt` and `ptr1-stderr.txt`: `muse serve` exits 3 on Windows
  with a schema-2 pointer, and with a version-1 provider whose storage is
  the Keychain.

Every probe's trace shows 0 model attempts. No real sign-in or sign-out was
made, and no token was read.

## What changed

| Behaviour                                                                                                                                                                                                                                                                    | Where                                                                                                 | Tests                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.json` is parsed for its structure only: schema version, any provider named, a Keychain `storage` lane. The schema drops every other field. A file over 64 KiB, a folder or a stat failure is not read.                                                                 | `src/core/backends/musecode/credentialFile.ts`, `readCredentialFile` in `src/host/auth/cliAccount.ts` | `credentialFile.test.ts` (the captured shapes on each OS, six malformed files); `cliAccount.test.ts` (`readCredentialFile`)                          |
| No file, or the empty file a sign-out leaves, is signed out without a process. A file holding the credential is signed in.                                                                                                                                                   | `CliAccount.signIn`                                                                                   | `cliAccount.test.ts`; `authService.test.ts` "AuthService over the CLI’s real credential file"; `cliAccount.e2e.test.ts`                              |
| A macOS pointer on macOS, or a file the structure cannot place, is asked of the CLI (`account/read` on a short-lived `experimentalApi` host). The answer is kept per path, size and mtime.                                                                                   | `CliAccount.confirm`, `probeAccount`                                                                  | `cliAccount.test.ts` (cache by mtime and by size, one shared question, a failed answer asked again on a click); `cliAccount.e2e.test.ts` (one probe) |
| On macOS the CLI is asked only on a user action (Check again, sign-in, sign-out, Diagnostics), never on activation or panel open.                                                                                                                                            | `CliAccount.confirm`; `AuthService.refresh(isUserAction)`; the controller's `retryBackend`            | `cliAccount.test.ts`; `authService.test.ts` "when the CLI may be asked"; `conversationController.test.ts`                                            |
| A macOS pointer on Windows or Linux is a named error that gives the file's path; the browser sign-in is refused with the same text instead of starting a host that exits 3.                                                                                                  | `AuthService.selectedSnapshot`, `signInWithCli`; `UI_TEXT.cliKeychainElsewhere`                       | `authService.test.ts` "a credential file Muse Code cannot start with"                                                                                |
| Sign-out goes through MSP `account/logout`, confirmed by `account/read`. `muse logout` in a terminal is the fallback. The logout hold ends once the file or the CLI shows no sign-in, even though the file stays.                                                            | `logOutAccount`; `AuthService.performSignOut`, `refresh`                                              | `accountHost.test.ts`; `authService.test.ts` (the rewritten former 845–853 case, the account/logout path, the fallback, the real-file cases); e2e    |
| The device sign-in succeeds on any of three signals: `granted` confirmed by `account/read`; `account/read` turning `accountLogin` while polling; a new file that `account/read` does not contradict. A CLI without `account/read` falls back to the host's word or the file. | `runDeviceSignIn`                                                                                     | `deviceSignIn.test.ts` "how it ends"                                                                                                                 |
| `denied`, `expired` and `failed` end the flow at once. Each shows its own localized message, and the host's message goes to the log, clipped. An unknown or malformed ending keeps waiting.                                                                                  | `runDeviceSignIn`; `AuthService` (`signInDenied`, `signInExpired`, `signInNotSaved`)                  | `deviceSignIn.test.ts`; `authService.test.ts` "how Muse Code ends a browser sign-in"                                                                 |
| A Cancel pressed while the pre-check reads the file is kept: the controller exists before that read, and an aborted flow never starts.                                                                                                                                       | `AuthService.signInWithCli`                                                                           | `authService.test.ts` "cancels the running device flow" (it caught the regression during this work)                                                  |
| The account's `label` (an e-mail address) is dropped by the `account/read` parse and never logged.                                                                                                                                                                           | `accountStateSchema`                                                                                  | `accountHost.test.ts`; `deviceSignIn.test.ts`; `cliAccount.e2e.test.ts` (the fake CLI sends a label)                                                 |
| Diagnostics names the file's structure and the CLI's sign-in. On macOS it adds the Keychain item's presence (`security find-generic-password -s ai.meta.dev.credentials -a meta`, no `-g`/`-w`: exit 0 or 44).                                                               | `renderSupportReport`, `keychainItemPresence`, the Diagnostics command                                | `supportReport.test.ts`; `credentialFile.test.ts`                                                                                                    |

The fake CLI (`test/e2e/fake-muse/serve.mjs`) now echoes `experimentalApi`.
For a client that asked for it, it serves `account/read` from the
credential file under `XDG_CONFIG_HOME`. It serves `account/logout` by
rewriting that file as the empty one the CLI leaves.
`installFakeCredential` writes a stored login's structure (schema 1, one
provider, no secret) instead of `{"fake": true}`.

## Drills

Each drill broke one guard in the working tree and ran the named suites.
The original bytes were then written back from memory, never through git.
Every target's SHA-256 matched its pre-drill value, before and after all
seventeen (`scratchpad/cred-fix/drills.mjs`, `drills-result.json`).

| Drill | What was broken                                                     | Suites                                  | Result                                                                                                         |
| ----- | ------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A     | The empty file a sign-out leaves read as a sign-in                  | credentialFile, cliAccount, authService | exit 1, 8 failed; first "reads the empty file a sign-out leaves as signed out, without starting the CLI"       |
| B     | A macOS Keychain pointer accepted off macOS                         | credentialFile, cliAccount              | exit 1, 3 failed; first "names a macOS pointer on Windows without starting a host that would exit"             |
| C     | macOS asks the CLI without a user action                            | cliAccount                              | exit 1, 1 failed: "asks about a macOS Keychain pointer only on a user action"                                  |
| D     | The answer cached without the file's size and mtime                 | cliAccount, cliAccount.e2e              | exit 1, 2 failed; first "asks about a malformed file off macOS at once, and keeps the answer until it changes" |
| E     | A failed answer never asked again on a user action                  | cliAccount                              | exit 1, 1 failed: "keeps a failed answer for passive looks, and asks again on a user action"                   |
| F     | Sign-out skips `account/logout` (terminal only)                     | authService                             | exit 1, 4 failed; first "clears the key, signs the CLI out through account/logout, and restarts"               |
| G     | The hold counts any credential file as a sign-in (the original bug) | authService                             | exit 1, 8 failed; first "keeps an environment-authenticated CLI gated until its key is removed"                |
| H     | A Keychain pointer off macOS not named in the gate                  | authService                             | exit 1, 1 failed: "names a macOS Keychain pointer on Windows or Linux instead of offering a dead sign-in"      |
| I     | Browser sign-in starts a host that would exit on that pointer       | authService                             | exit 1, 1 failed: the same case                                                                                |
| J     | A Cancel during the pre-check is lost                               | authService                             | exit 1, 1 failed: "cancels the running device flow without changing credentials"                               |
| K     | `denied`, `expired`, `failed` ignored (only `cancelled` ends)       | deviceSignIn                            | exit 1, 3 failed; first "ends at once on denied, logs the host’s reason, and needs no loginCancel"             |
| L     | `granted` or a new file taken while `account/read` says signed out  | deviceSignIn                            | exit 1, 2 failed; first "waits while the store does not show a granted sign-in yet"                            |
| M     | `account/read` polling not a sign-in signal                         | deviceSignIn                            | exit 1, 1 failed: "notices a sign-in by polling account/read when no outcome arrives"                          |
| N     | `account/logout` trusted without `account/read`                     | accountHost                             | exit 1, 4 failed; first "is false when account/logout is refused"                                              |
| O     | The account label kept by the `account/read` parse                  | accountHost                             | exit 1, 1 failed: "keeps the state and drops the label"                                                        |
| P     | Check again not a user action                                       | conversationController                  | exit 1, 1 failed: "delegates sign-in, sign-out, retry and external links"                                      |
| Q     | The Diagnostics Keychain line dropped                               | supportReport                           | exit 1, 1 failed: "describes the CLI’s sign-in by the file’s structure and the Keychain item"                  |

## Not proved here

A real sign-in is the owner's to give, and each of these needs one:

- **A 1.4.0 macOS device login.** It should write the Keychain item and a
  schema-2 pointer. The pointer's mtime should change on a same-account
  re-login, which is the device flow's third signal.
- **The success sequence.** The order and timing of
  `account/loginCompleted {outcome: "granted"}` against `account/read`.
  `granted`, `denied`, `expired` and `failed` are the schema's
  `AccountLoginOutcome` words; only `cancelled` was captured live (M55).
- **Logout of an OAuth login slot.** It should leave the same empty file,
  and the server-side revoke is unverified. Stored keys were verified.
- **Keychain prompts.** Whether one appears after a CLI update (a new
  binary path), and what `account/read` says with the item present but the
  Keychain locked (Remote-SSH into a Mac).
- **Windows and Linux R4302.1.** Whether a device-code login persists to
  the file. Only the stored-key writer was exercised.

## The gate

Run on the working tree (Windows 11, 2026-09-27), before the commit:

- `npm run test:unit` (after the size trims below): 177 files passed and 2
  skipped; 2,583 tests passed and 23 skipped; coverage thresholds met.
- `npm run typecheck`, `npm run lint`, `npm run format:check`,
  `npm run check:l10n` (14 tables, 0 problems), `knip`, `npm run cycles`
  and `npm run duplication` (0 clones): all exit 0.
- `npm run build`: **fails the D6 host budget**. `dist/extension.js` is
  602.7 KiB against 600 KiB; `main` was 596.8 KiB. The fix adds about
  6.0 KB minified:
  - the account host helpers, about 2.1 KB;
  - the CLI account check, about 1.6 KB;
  - the AuthService changes, about 0.9 KB;
  - the structural read, about 0.5 KB;
  - four strings, about 0.5 KB;
  - the constants, about 0.4 KB.

  Sharing one host lifecycle between the probe and the logout, a lookup
  in place of a switch, one verdict accessor and plain words in
  Diagnostics already took 0.85 KB off. The budget was not raised (AGENTS.md
  rule 2): raising it, or a size cut elsewhere in the host bundle, is the
  owner's decision.

The full `npm run quality` run is reported with the pull request.
