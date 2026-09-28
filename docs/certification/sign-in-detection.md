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
- the `account/read` states the code relies on, all captured with
  `credentialRequired: true`: `accountLogin` and `loggedOut`
  (`probe-account-*.json`, `probe-logout-iso*.json`), `apiKey` after
  `muse auth set` (`probe-authset-*.json`), and `envKey` with `META_API_KEY`
  set (`envkey-account-read.txt`). `credentialRequired: false` was never
  seen, so no code gives it a meaning;
- `ptr-stderr.txt` and `ptr1-stderr.txt`: `muse serve` exits 3 on Windows
  with a schema-2 pointer, and with a version-1 provider whose storage is
  the Keychain;
- `probe-v2-serve.mjs` and its redacted output `probe-v2-serve.json` (the
  third review round, below): `muse serve` exits 3 on an empty version-2
  file too, and starts with a version-2 file when `META_API_KEY` is set;
- the bundled Slack connector, `slack_connector.py` in the `muse-core`
  plugin's cache (1.4.0-R4302.1), reads its own
  `providers.slack_connector.bot_token` from the same `auth.json` (its
  lines 18–20, 60 and 505): a provider in the file is not necessarily a
  Muse sign-in.

Every probe's trace shows 0 model attempts. No real sign-in or sign-out was
made, and no token was read.

## What changed

| Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Where                                                                                                                                               | Tests                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.json` is parsed for its structure only: schema version, which providers are named, a Keychain `storage` lane. The schema drops every other field. Only `providers.meta` speaks for the sign-in; the bundled Slack connector’s entry does not (review round 3). A file over 64 KiB, a folder or a stat failure is not read.                                                                                                                             | `src/core/backends/musecode/credentialFile.ts` (`MUSE_CREDENTIAL_PROVIDER`), `readCredentialFile` in `src/host/auth/cliAccount.ts`                  | `credentialFile.test.ts` (the captured shapes, a Slack-only file, six malformed files); `cliAccount.test.ts`; `cliAccount.e2e.test.ts`                   |
| No file, or the empty file a sign-out leaves, is signed out without a process. A `meta` entry holding the credential is signed in. Other providers alone are asked of the CLI.                                                                                                                                                                                                                                                                               | `CliAccount.signIn`                                                                                                                                 | `cliAccount.test.ts`; `authService.test.ts` "AuthService over the CLI’s real credential file"; `cliAccount.e2e.test.ts`                                  |
| A macOS pointer on macOS, or a file the structure cannot place, is asked of the CLI (`account/read` on a short-lived `experimentalApi` host). The answer is kept per path, size and mtime.                                                                                                                                                                                                                                                                   | `CliAccount.confirm`, `AccountHosts.probe`                                                                                                          | `cliAccount.test.ts` (cache by mtime and by size, one shared question, a failed answer asked again on a click); `cliAccount.e2e.test.ts` (one probe)     |
| On macOS the CLI is asked only on a user action (Check again, sign-in, sign-out, the Sign Out and Diagnostics commands), never on activation or panel open.                                                                                                                                                                                                                                                                                                  | `CliAccount.confirm`; `AuthService.refresh(isUserAction)`, `checkAgain`                                                                             | `cliAccount.test.ts`; `authService.test.ts` "when the CLI may be asked"; `conversationController.test.ts`                                                |
| Cancel leaves an unanswered probe behind and keeps the remembered answer. A sign-out, a device sign-in and Check again forget the answer too, so a Keychain change that leaves the file as it was is seen (review round 3).                                                                                                                                                                                                                                  | `CliAccount.abandonProbe`, `forgetAnswers`; `AuthService.cancelSignIn`, `checkAgain`, `signInWithCli`, `logOutCli`; the controller’s `retryBackend` | `cliAccount.test.ts`; `authService.test.ts` (the real-file cases); `conversationController.test.ts`                                                      |
| A macOS file on Windows or Linux (any version 2, the empty one included, or a Keychain lane on `meta`) is a named error that gives the file’s path. The browser sign-in is refused with the same text instead of starting a host that exits 3. `META_API_KEY` still wins: `muse serve` starts with it.                                                                                                                                                       | `AuthService.selectedSnapshot`, `signInWithCli`, `cliCredential`; `UI_TEXT.cliCredentialUnsupported`                                                | `credentialFile.test.ts`; `authService.test.ts` "a credential file Muse Code cannot start with"                                                          |
| Sign-out goes through MSP `account/logout`, confirmed by `account/read`. When that does not confirm it, the sign-in is read afresh; only a sign-in still there opens `muse logout` in a terminal, which gets `museSpark.environmentVariables`. The logout hold ends once the file or the CLI shows no sign-in, even though the file stays. A sign-out that keeps the hold is published as `error`, so the panel offers the Check again its message asks for. | `logOutAccount`; `AuthService.performSignOut`, `logOutCli`, `refresh`; `terminalEnvironment`, `runCliInTerminal`                                    | `accountHost.test.ts`; `authService.test.ts`; `launch.test.ts`; e2e                                                                                      |
| The device sign-in succeeds on either of two signals: `account/read` turning `accountLogin` while polling; a new file that `account/read` does not contradict. A CLI that cannot answer `account/read` falls back to the file. The captured `granted` comes after both, so it is no signal of its own. With no first `account/read`, only a new file counts.                                                                                                 | `runDeviceSignIn`, `isSignedIn`                                                                                                                     | `deviceSignIn.test.ts` "how it ends"; `cliAccount.e2e.test.ts` (the granted sequence replayed)                                                           |
| `account/loginCompleted` ends the flow at once on any outcome but `granted`. The captured `expired`, `denied` and `failed` show their own messages; any other word is shown as Muse Code sent it (`signInEnded`). Only `expired`’s and `denied`’s messages reach the log; `failed`’s names a path, so a fixed line stands in. A malformed ending keeps waiting.                                                                                              | `runDeviceSignIn` (`loggedEnding`); `AuthService` (`signInExpired`, `signInDenied`, `signInSaveFailed`, `signInEnded`)                              | `deviceSignIn.test.ts`; `authService.test.ts` "how Muse Code ends a browser sign-in"; `cliAccount.e2e.test.ts` (the captured frames replayed)            |
| Cancel, the host’s ending and the host’s exit are noticed at once, even while an `account/read` goes unanswered: each poll and each wait races a stop signal, which `connection.closed` also trips. An exit fails the sign-in. `account/loginCancel` is bounded at 2 s, then the host is closed anyway.                                                                                                                                                      | `runDeviceSignIn` (`untilStopped`, `cancelLogin`); `MUSE_LOGIN_CANCEL_TIMEOUT_MS`                                                                   | `deviceSignIn.test.ts` "a CLI that stops answering", "a host that exits"; `cliAccount.e2e.test.ts` (the fake leaves `account/read` unanswered, or exits) |
| The extension waits 11 minutes, past the captured 600 s code lifetime, so Muse Code’s own `expired` ends an unapproved code. Before, it cancelled at 5 minutes a code the browser could still approve.                                                                                                                                                                                                                                                       | `CREDENTIAL_POLL_TIMEOUT_MS`                                                                                                                        | `deviceSignIn.test.ts` "waits past the captured code lifetime"                                                                                           |
| A Cancel pressed while the pre-check reads the file is kept: the controller exists before that read, and an aborted flow never starts. A Cancel pressed after the credential file changed lets the file decide (review round 3).                                                                                                                                                                                                                             | `AuthService.signInWithCli`, `finishCancelledCliSignIn`                                                                                             | `authService.test.ts` "cancels the running device flow", "lets the credential file decide a Cancel pressed just after the browser approved"              |
| Sign-out never waits on a question a finished or failed sign-in asks: the confirming `cliSignIn(true)` and each `refresh(true)` race the flow’s signal or the sign-out’s. A refresh begun before or during a sign-out cannot publish after it: the epoch moves as the sign-out starts and ends (review round 3).                                                                                                                                             | `AuthService.confirmCliSignIn`, `refreshUnlessCancelled`, `finishFailedCliSignIn`, `performSignOut`                                                 | `authService.test.ts` "sign-in, sign-out and Cancel racing", "keeps the state a sign-out published …"                                                    |
| The window closing closes every short-lived account host through one `AbortController`, probes Cancel left behind included, then cancels the sign-in and waits for it, then stops the backends (review round 3).                                                                                                                                                                                                                                             | `AccountHosts`; `AuthService.stopSignIn`; `lifecycle.shutdown` in `extension.ts`                                                                    | `accountHost.test.ts` "AccountHosts"; `authService.test.ts` "cancels the browser sign-in and waits for it to end"                                        |
| The account’s `label` (an e-mail address) and `avatarUrl` are dropped by the `account/read` parse and never logged.                                                                                                                                                                                                                                                                                                                                          | `accountStateSchema`                                                                                                                                | `accountHost.test.ts` (the captured signed-in answer); `deviceSignIn.test.ts`; `cliAccount.e2e.test.ts` (the fake CLI sends a label)                     |
| Diagnostics names the file’s structure and the CLI’s sign-in. On macOS it adds the Keychain item’s presence (`security find-generic-password -s ai.meta.dev.credentials -a meta`, no `-g`/`-w`: exit 0 or 44). Its `account/read` may make the CLI read the Keychain, which can prompt.                                                                                                                                                                      | `renderSupportReport`, `keychainItemPresence`, the Diagnostics command                                                                              | `supportReport.test.ts`; `credentialFile.test.ts`                                                                                                        |

The fake CLI (`test/e2e/fake-muse/serve.mjs`) now echoes `experimentalApi`.
For a client that asked for it, it serves `account/read` from the
credential file under `XDG_CONFIG_HOME`: `providers.meta` is a login,
anything else signed out. It serves `account/logout` by rewriting that
file as the empty one the CLI leaves. `installFakeCredential` writes the
granted capture's file structure (schema 1, `meta` with the captured keys,
placeholders for every value) instead of `{"fake": true}`.

The fake also runs the device sign-in from the live captures below. It
reads `test/fixtures/msp/account-login-*.json` from `MUSE_FAKE_CAPTURES`:

- `account/loginStart` answers as captured;
- `MUSE_FAKE_LOGIN_ENDING` sends, after `MUSE_FAKE_LOGIN_ENDING_MS`, the
  notifications that capture received before its `loginCancel`. For
  `granted` it first writes the file as the browser sign-in left it, then
  sends `account/changed`, the ending and `account/changed` again;
- `account/loginCancel` sends the captured `cancelled` ending, then
  `{cancelled: true}`, in the captured order;
- `MUSE_FAKE_ACCOUNT_READ=silentAfterStart` leaves `account/read`
  unanswered once the flow has started;
- `MUSE_FAKE_LOGIN_EXIT_MS` exits that long after `loginStart`, a host
  that dies mid-flow.

The unit tests read the same files through
`test/unit/helpers/accountLoginCapture.ts`. The file shapes the tests use
are in `test/unit/helpers/credentialShapes.ts`: the `muse auth set` file
(schema 1, `meta` with `api_key` alone, `probe-authset-*.json`), the
device-login file (the granted capture) and the logout shell. Every
shape nobody captured (the third party's macOS pointer, the Slack-only
file, a file cut short) says so in a comment.

Checked in the third review round and left as it was:

- **`markAuthRequired`.** It publishes `signedOut` with the backend's own
  `authRequired` reason, which asks for no Check again. The panel shows the
  sign-in buttons that reason calls for, so C1's mismatch does not arise.
- **`META_API_KEY` before the file.** The W2 capture showed `muse serve`
  starting with a version-2 file when the key is set, so the key still
  wins over the file check.
- **`granted`.** Captured now, it still needs no handler: it comes after
  the file and `account/read` already show the sign-in.

## Live capture of the device sign-in (PR #49 review)

Codex's review of PR #49 raised two findings:

- **P1.** The `loginCompleted` handlers were written from the schema's
  words; only `cancelled` had been captured.
- **P2.** A poll that awaited `account/read` held up Cancel and the host's
  ending for 30 s when the CLI stopped answering.

The owner authorized real device sign-ins with his account for this
capture.

- **How it was driven.** `scratchpad/cred-capture/capture.mjs` drove
  `muse-bin-1.4.0-R4302.1.exe serve` over raw MSP NDJSON, with
  `experimentalApi`, as the extension asks.
  - The machine was Windows 11, `serverInfo` 1.4.0, build `aebe0c18`.
  - It asked `account/read` every second and recorded every frame. Each
    frame was redacted before it was written.
- **The throwaway home.** Each run had a new `mkdtemp` folder under
  `%TEMP%`.
  - It held `HOME`, `USERPROFILE`, every `XDG_*_HOME`, `APPDATA`,
    `LOCALAPPDATA` and an empty workspace. `META_API_KEY` and
    `TBH_CREDENTIAL_BACKEND` were removed.
  - A run went on only when three checks held: the host's `museHome` was
    in that folder, the trace said `config_root source="xdg"`, and
    `account/read` said `loggedOut`.
- **Safety.**
  - The owner's `auth.json` was only `stat`ed: 640 bytes and mtime
    2026-09-22 20:21:02Z, before and after every run.
  - Each throwaway home was deleted and checked gone.
  - No session started, and every trace counted 0 model attempts.
  - No code was approved, so no token was issued or written.

| Capture               | 2026-09-27 (PDT) | Browser                 | Frames                                           | What the wire did                                                                                                                                                                                                                 |
| --------------------- | ---------------- | ----------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| expired               | 18:13–18:23      | none: the code was left | `test/fixtures/msp/account-login-expired.json`   | `{outcome: "expired", message: "login failed: the request expired"}` came 600.5 s after `loginStart`'s answer, with no `account/changed`. `account/read` stayed `loggedOut`. A later `loginCancel` answered `{cancelled: false}`. |
| cancelled             | 18:14–18:22      | none (see below)        | `test/fixtures/msp/account-login-cancelled.json` | The run meant to approve the code, and sent `loginCancel` at its 482 s deadline. `{outcome: "cancelled"}`, with no message, arrived before the `{cancelled: true}` answer. The code was still live at 482 s.                      |
| a blocked config path | 18:22            | none                    | not kept                                         | A regular file where the `muse` config folder goes. `serve` started, `account/read` said `loggedOut`, and `loginStart` answered as usual. The save failure this was set up for comes only after an approval.                      |

- **`loginStart`.** It answers exactly `{verificationUrl, userCode}`,
  with no expiry field. The URL is
  `https://auth.meta.com/oauth/device/?code=<the code>`, and the code is
  4+4 letters.
- **`emittedAtMs`.** 1.4.0 adds a frame-level `emittedAtMs` to
  notifications. The SDK's `Notification` type has it.
- **What the fixtures keep.** The first two polls, and the last one before
  the ending. The code is replaced by its shape, `AAAA-AAAA`; no label,
  e-mail or token was in any frame.

In that first round `granted`, `denied` and `failed` could not be
captured: each needs a click on the device page in the owner's signed-in
Chrome, and the Chrome Control extension was disabled in that profile.
They were captured later the same evening (below).

### The success, a denial and a failed save (review round 3)

- **When and how.** 2026-09-27, 21:27–21:30 PDT (2026-09-28T04:27Z–04:30Z).
  `scratchpad/cred-capture/capture2.mjs` drove the same build
  (1.4.0-R4302.1, `serverInfo` 1.4.0, build `aebe0c18`, Windows 11) over
  raw MSP NDJSON with `experimentalApi`, one run per outcome. The raw
  redacted frames and each run's summary are in
  `scratchpad/cred-capture/out/live2/`; the fixtures were made from them.
- **The throwaway home.** As before: a new `mkdtemp` folder per run, with
  `HOME`, `USERPROFILE`, every `XDG_*_HOME`, `APPDATA`, `LOCALAPPDATA` and
  an empty workspace inside it, and `META_API_KEY`, `TBH_CREDENTIAL_BACKEND`
  and `MUSE_AUTH_PATH` removed. The trace confirmed
  `config_root source="xdg"` before `loginStart`. Each home was deleted
  and checked gone.
- **The browser.** The device page (`auth.meta.com/oauth/device/?code=…`)
  in the owner's signed-in Chrome asked only "Approve Muse Code?", with the
  code and two buttons, **Approve** and **Deny**. About 20 s after
  `loginStart`, Approve was clicked for `granted` and `failed`, and Deny
  for `denied`. The page then said "Muse Code was approved" or "… was
  denied".
- **Safety.** Every trace counted 0 model attempts; no session started.
  The owner's own `auth.json` was only `stat`ed (640 bytes, mtime
  2026-09-22T20:21:02.598Z) before, between and after the runs, unchanged
  (`live2/real-auth-stat.txt`). The `granted` run signed out through
  `account/logout` in the same home before the home was deleted; the trace
  logged `credential.revoke` with outcome `revoked`.
- **Redaction.** The user code is its shape, `AAAA-AAAA`; `museHome` and
  paths are under `<throwaway>`; the account's label and avatar address are
  the stand-ins `someone@example.com` and `https://example.com/avatar.png`,
  replaced by key before any frame was written. No token is in any frame.

| Capture | 2026-09-27 (PDT)  | Clicked | Frames                                         | What the wire did                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | ----------------- | ------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| granted | 21:27:45–21:28:15 | Approve | `test/fixtures/msp/account-login-granted.json` | The file first appeared 20.43 s after `loginStart`'s answer (437 B). `account/changed {state: accountLogin, credentialRequired: true}`, with no label, came at 21.25 s, as the next poll's `account/read` also said `accountLogin`. The file was rewritten (1062 B: schema 1, `providers.meta` with `access_token`, `obtained_via: "device_code"`, `mechanism: "oauth"`, `api_key`, `api_base_url` and the account's name, e-mail and avatar address). `{outcome: "granted"}`, with no message, came at 21.46 s; a second `account/changed`, now with `label` and `avatarUrl`, 1 ms later. `account/logout` answered `{state: loggedOut, credentialRequired: true}` in 27 ms, and the file became the 44-byte `{"schema_version":1,"providers":{}}`. |
| denied  | 21:29:03–21:29:28 | Deny    | `test/fixtures/msp/account-login-denied.json`  | `{outcome: "denied", message: "login failed: the request was denied"}` came 20.4 s after `loginStart`'s answer. No `account/changed`; `account/read` stayed `loggedOut`; no file was written.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| failed  | 21:29:35–21:30:00 | Approve | `test/fixtures/msp/account-login-failed.json`  | A regular 49-byte file stood where `cfg\muse` goes. `{outcome: "failed", message: "login succeeded but saving failed: failed to write credential file at <throwaway>\cfg\muse: Cannot create a file when that file already exists. (os error 183)"}` came 20.5 s after `loginStart`'s answer. The message names a local path, which is the user's profile folder in real life. No `account/changed`; `account/read` stayed `loggedOut`; nothing was written; the trace shows no `credential.refresh`, so no key was minted.                                                                                                                                                                                                                          |

- **`avatarUrl`.** `account/read` and `account/changed` carry an
  `avatarUrl` the MSP schema does not list. The schema parse is lenient
  and drops it, with the label.
- **What changed because of it.** `denied` and `failed` have their own
  messages (`signInDenied`, `signInSaveFailed`), and `signInEnded` is left
  for words never seen. The log keeps `expired`'s and `denied`'s messages
  only: `failed`'s names a path, so the log says "saving the credential
  failed". `granted` keeps no handler: it comes after the file and
  `account/read` already show the sign-in.

**What the wire showed that the code had wrong.**

- **The code's lifetime.** A code lives 600 s. The extension gave up at
  5 minutes and cancelled a code the browser could still approve, so its
  `expired` handler could never be reached.
  - The backstop is now 11 minutes (`CREDENTIAL_POLL_TIMEOUT_MS`), checked
    against the lifetime measured in the fixture.
  - The panel now shows Muse Code's own `expired`.
- **The message.** `expired` carries one, as the schema says; `cancelled`
  carries none.
- **`account/changed`.** It did not fire for an expired code either, so it
  stays unused.
- **The order.** The ending precedes the `loginCancel` answer.

## An empty version-2 file off macOS (review round 3, W2)

The second review round read `{"schema_version":2,"providers":{}}` as
signed out on every OS. The nearest capture, `ptr-stderr.txt`, showed
Windows refusing a pointer on its version alone. So the file was given
to `muse serve` itself.

- **How.** `scratchpad/m140cred/probe-v2-serve.mjs`, 2026-09-27 21:38 PDT
  (2026-09-28T04:38Z), Windows 11, the installed
  `muse-bin-1.4.0-R4302.1.exe serve`. Each case had a new `mkdtemp` home
  (`HOME`, `USERPROFILE`, every `XDG_*_HOME`, `APPDATA`, `LOCALAPPDATA`),
  holding exactly the file named; `META_API_KEY`, `TBH_CREDENTIAL_BACKEND`
  and `MUSE_AUTH_PATH` were removed, and the network went to a dead proxy
  (`127.0.0.1:9`). The probe sent `initialize` with `experimentalApi` and,
  if the host started, one `account/read`, then closed it. No session, no
  sign-in, 0 model attempts in every trace. The owner's `auth.json` was
  only `stat`ed, unchanged; every home was removed.
- **The output.** `scratchpad/m140cred/probe-v2-serve.json`, redacted
  (paths under `<throwaway>`, the dummy key as `<dummy key>`, the label
  replaced).

| Case                                      | `META_API_KEY`         | What `serve` did                                                                                                         |
| ----------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `{"schema_version":2,"providers":{}}`     | unset                  | exit 3 after 425 ms, before `initialize`: `compose serve model client: unsupported auth schema version 2 at …\auth.json` |
| a version-2 pointer (`storage: keychain`) | unset                  | the same exit 3 and message (the control case)                                                                           |
| a version-2 pointer                       | a dummy value (no key) | started; `account/read` answered `{state: envKey, credentialRequired: true}`                                             |
| `{"schema_version":2,"providers":{}}`     | a dummy value          | started; `account/read` answered `envKey`                                                                                |

- **The verdict.** Muse Code refuses any version-2 file off macOS on its
  version, the empty one included. The structural read now names every
  version-2 file off macOS as one Muse Code cannot start with. The verdict
  was `keychainElsewhere`; it is `unsupportedHere` now, because an empty
  file points to no Keychain. Its message, `cliCredentialUnsupported`,
  says the file is in the macOS format, in every table. Linux is treated
  like Windows; it was not probed.
- **The environment key.** With `META_API_KEY` set, `serve` starts with a
  version-2 file and uses the key, so the key still bypasses the file
  check (`AuthService.cliCredential`), as before.

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

Drills R to AA cover the PR #49 review fixes. They ran the same way, on
the final tree, from `scratchpad/cred-capture/drills.mjs`
(`drills-result.json`). After all ten, each target's SHA-256 matched its
pre-drill value.
"e2e" is `test/e2e/cliAccount.e2e.test.ts`, whose fake CLI replays the
captured frames.

| Drill | What was broken                                                                                                | Suites                   | Result                                                                                                                                   |
| ----- | -------------------------------------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| R     | A poll waits for an unanswered `account/read` (the P2 race removed)                                            | deviceSignIn, e2e        | exit 1, 6 failed (4 unit, 2 e2e, each at its test timeout); first "ends at once on the host’s ending while account/read goes unanswered" |
| S     | The wait between polls does not notice Cancel                                                                  | deviceSignIn             | exit 1, 1 failed: "notices Cancel during the wait between polls"                                                                         |
| T     | `loginCancel` waits the 30 s MSP deadline instead of 2 s                                                       | deviceSignIn             | exit 1, 2 failed; first "closes the host after Cancel even when loginCancel is never answered"                                           |
| U     | The captured `expired` loses its own meaning                                                                   | deviceSignIn, e2e        | exit 1, 6 failed; first (e2e) "ends on the captured expired ending, shown the code as captured"                                          |
| V     | The captured `cancelled` loses its own meaning                                                                 | deviceSignIn             | exit 1, 1 failed: "treats the captured cancellation ending as terminal"                                                                  |
| W     | An ending no capture covers keeps the flow waiting (the old rule)                                              | deviceSignIn             | exit 1, 5 failed; first "ends at once on denied, which no capture covers, as the CLI named it"                                           |
| X     | The uncaptured `granted` ends the flow like any other word                                                     | deviceSignIn             | exit 1, 2 failed; first "takes an uncaptured granted for nothing: account/read decides"                                                  |
| Y     | Every ending shown with the `expired` text                                                                     | authService              | exit 1, 3 failed; first "ends an uncaptured denied sign-in at once, signed out with its reason"                                          |
| Z     | The extension gives up at 5 minutes, before the captured code lifetime                                         | deviceSignIn             | exit 1, 1 failed: "waits past the captured code lifetime, so Muse Code ends an unapproved code itself"                                   |
| AA    | An ending that arrives before `loginStart` answers is taken for Cancel                                         | deviceSignIn             | exit 1, 1 failed: "ends on the host’s ending while loginStart is unanswered, with no code shown"                                         |
| AB    | The pre-flight account probe awaited without the flow's signal (the review of PR #49)                          | `authService.test.ts`    | exit 1, 1 failed: Cancel waited on a probe the CLI never answered                                                                        |
| AC    | Sign-out and the next sign-in rejoin a probe Cancel abandoned (the review of PR #49)                           | `cliAccount.test.ts`     | exit 1, 1 failed: the second question waited on the unanswered probe                                                                     |
| AD    | A file change counted as a sign-in after a stop, while a poll went unanswered (the review of PR #49)           | `deviceSignIn.test.ts`   | exit 1, 1 failed: the expired code was reported as a sign-in                                                                             |
| AE    | `account/read`'s uncaptured `credentialRequired: false` read as a keyless sign-in (the review of PR #49)       | `cliAccount.test.ts`     | exit 1, 1 failed: a signed-out answer with the flag false became `signedIn`                                                              |
| AF    | The device flow's signed-out guard gated on `credentialRequired` again (the review of PR #49)                  | `deviceSignIn.test.ts`   | exit 1, 1 failed: a rewritten file counted as a sign-in under the uncaptured value                                                       |
| AG    | An empty version-2 file read as a Keychain pointer off macOS (the review of PR #49)                            | `credentialFile.test.ts` | exit 1, 2 failed: a signed-out macOS file copied to Windows or Linux blocked browser sign-in                                             |
| AH    | `account/logout` confirmed on any answer but a stored sign-in (the review of PR #49)                           | `accountHost.test.ts`    | exit 1, 2 failed: `envKey` and the uncaptured `credentialRequired: false` confirmed a logout                                             |
| AI    | A refresh begun before sign-out publishes its late answer (the review of PR #49)                               | `authService.test.ts`    | exit 1, 1 failed: the signed-out state was overwritten with "Sign-out is in progress"                                                    |
| AJ    | A sign-in cancelled by sign-out still announces its own cancellation                                           | `authService.test.ts`    | exit 1, 1 failed: "Sign-in cancelled" was shown during the sign-out                                                                      |
| AK    | The CLI's answer returned although the credential file was rewritten while it was asked (the review of PR #49) | `cliAccount.test.ts`     | exit 1, 1 failed: a sign-out rewrite during the probe still read as signed in                                                            |
| AL    | The CLI's remembered answer kept after a confirmed logout that left the file unchanged (the review of PR #49)  | `authService.test.ts`    | exit 1, 1 failed: a Keychain-style logout stayed signed in and kept the hold                                                             |

Drills AM to BJ cover the third round of the PR #49 review (the races R1–R6,
the wire evidence W1–W2, the failure paths C1–C9). They ran the same way, on
the final tree, from `scratchpad/cred-capture/drills2.mjs`
(`drills2-result.json`): each target's SHA-256 matched its pre-drill value
after every drill and after all twenty-four. The fixes with no product guard
have no drill: W3 and C10 change test data and test timing only, C7 and C8
docs and a comment, and W2's environment-key finding confirmed the code as it
was.

| Drill | What was broken                                                                              | Suites                                         | Result                                                                                                                  |
| ----- | -------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| AM    | R1: a finished sign-in confirms the new sign-in (after a sign-out) without the flow’s signal | `authService.test.ts`                          | exit 1, 1 failed: "signs out without waiting on a finished sign-in confirming the sign-in after a sign-out"             |
| AN    | R1: a finished sign-in’s last `refresh(true)` without the flow’s signal                      | `authService.test.ts`                          | exit 1, 1 failed: "signs out without waiting on a finished sign-in refreshing after the sign-in"                        |
| AO    | R2: Cancel forgets the remembered answer too (the old single hook)                           | `authService.test.ts`                          | exit 1, 2 failed; first "signs out without waiting on a pre-flight probe the CLI never answered (the review of PR #49)" |
| AP    | R2: a failed sign-in’s refresh does not yield to a sign-out                                  | `authService.test.ts`                          | exit 1, 1 failed: "signs out without waiting on the refresh a failed sign-in began"                                     |
| AQ    | R2: abandoning a probe drops the remembered answer too                                       | `cliAccount.test.ts`                           | exit 1, 1 failed: "keeps a remembered answer when a probe is abandoned, and asks afresh once forgotten"                 |
| AR    | R3: the sign-out epoch does not move as the sign-out ends                                    | `authService.test.ts`                          | exit 1, 1 failed: "keeps the state a sign-out published when a refresh begun during it answers late"                    |
| AS    | R4: Check again keeps the CLI’s remembered answers                                           | `authService.test.ts`                          | exit 1, 1 failed: "asks the CLI afresh on Check again, even about a sign-in it confirmed"                               |
| AT    | R4: the panel’s Check again is a plain `refresh(true)` again                                 | `conversationController.test.ts`               | exit 1, 1 failed: "delegates sign-in, sign-out, retry and external links"                                               |
| AU    | R5: with no first `account/read`, an existing `accountLogin` counts as a new sign-in         | `deviceSignIn.test.ts`                         | exit 1, 1 failed: "when the first account/read goes unanswered, takes no sign-in from before the flow for a new one"    |
| AV    | R6: Cancel publishes signed out although the file changed since the flow began               | `authService.test.ts`                          | exit 1, 1 failed: "lets the credential file decide a Cancel pressed just after the browser approved"                    |
| AW    | W1: any provider in `auth.json` counts as the Muse sign-in                                   | `credentialFile.test.ts`, `cliAccount.test.ts` | exit 1, 5 failed; first "asks the CLI about a file naming another provider alone"                                       |
| AX    | W1: the fake CLI counts any provider as a login                                              | e2e                                            | exit 1, 1 failed: "asks the CLI about a file naming another provider alone"                                             |
| AY    | W2: an empty version-2 file off macOS read as signed out                                     | `credentialFile.test.ts`                       | exit 1, 2 failed; first "names a macOS file Muse Code cannot start with on win32"                                       |
| AZ    | C1: a sign-out that keeps the hold publishes `signedOut`, with no Check again                | `authService.test.ts`                          | exit 1, 3 failed; first "ends the host and clears the key when the CLI logout terminal cannot open"                     |
| BA    | C2: the device flow does not notice its host exiting                                         | `deviceSignIn.test.ts`, e2e                    | exit 1, 3 failed; first "fails at once when the host exits during the flow"                                             |
| BB    | C3: an account host is not closed when the window closes                                     | `accountHost.test.ts`                          | exit 1, 1 failed: "closes a probe still waiting when the window closes, and starts none afterwards"                     |
| BC    | C3: closing the window does not wait for the cancelled sign-in                               | `authService.test.ts`                          | exit 1, 1 failed: "cancels the browser sign-in and waits for it to end"                                                 |
| BD    | C4: every `loginCompleted` message logged as sent, the failed path included                  | `deviceSignIn.test.ts`, e2e                    | exit 1, 3 failed; first "ends on the captured failed, and logs no path"                                                 |
| BE    | C4: the captured `denied` and `failed` lose their own meanings                               | `deviceSignIn.test.ts`, e2e                    | exit 1, 5 failed; first "ends on the captured denied, and logs no path"                                                 |
| BF    | C4: the captured `denied` shown with the generic text                                        | `authService.test.ts`                          | exit 1, 2 failed; first "ends the captured denied sign-in at once, signed out with its reason"                          |
| BG    | C4: the generic ending promises a log line that is not written                               | `authService.test.ts`                          | exit 1, 1 failed: "ends an unknown sign-in at once, signed out with its reason"                                         |
| BH    | C5: an unconfirmed logout always opens `muse logout` in a terminal                           | `authService.test.ts`                          | exit 1, 1 failed: "opens no muse logout terminal once the file shows no sign-in after an unconfirmed logout"            |
| BI    | C6: a CLI terminal gets none of `museSpark.environmentVariables`                             | `launch.test.ts`                               | exit 1, 1 failed: "gives a CLI terminal the configured variables, one spelling each on Windows"                         |
| BJ    | C9: a successful device sign-in keeps the CLI’s earlier answers                              | `authService.test.ts`                          | exit 1, 1 failed: "asks the CLI afresh after a browser sign-in, the file unchanged"                                     |

## Not proved here

A real sign-in is the owner's to give, and each of these needs one:

- **A 1.4.0 macOS device login.** It should write the Keychain item and a
  schema-2 pointer. The pointer's mtime should change on a same-account
  re-login, which is the device flow's third signal.
- **Keychain prompts.** Whether one appears after a CLI update (a new
  binary path), and what `account/read` says with the item present but the
  Keychain locked (Remote-SSH into a Mac).
- **Linux R4302.1.** Whether a device-code login persists to the file as
  it does on Windows, and whether `muse serve` refuses a version-2 file
  there as it does on Windows. The extension treats Linux like Windows.

Captured since the first version of this list, on Windows R4302.1: the
success sequence (`granted` against `account/read`, `account/changed` and
the file), a declined code, a failed save, and the logout of an OAuth
login slot, which left the same empty file and logged
`credential.revoke` with outcome `revoked` (above).

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

After the fix was joined with M57 (the Model API backend in its own bundle,
`dist/extension.js` down to about 425 KiB) and M58, `npm run quality` on
`2a4f0db` exited 0:

- `check:l10n` 14 tables, 0 problems; jscpd 0 clones;
- vitest: 179 files passed and 2 skipped; 2,605 tests passed and 23
  skipped; statements 94.47 %;
- build: `dist/extension.js` 434.9 KiB of 600, `dist/modelApi.js` 297.2 KiB
  of 400, the bundle-split check passed;
- a11y: 336 pages, 0 rules violated;
- gitleaks: no leaks; Semgrep: 287 rules on 416 files, 0 findings.

The budget question above is settled by M57; no budget was raised.

With the PR #49 review fixes, `npm run quality` on the working tree
(Windows 11, 2026-09-27, before the commit) exited 0:

- `check:l10n` 14 tables, 0 problems; knip and dpdm clean; jscpd 0 clones;
  PSScriptAnalyzer 0 findings;
- vitest: 179 files passed and 2 skipped; 2,619 tests passed and 23
  skipped; statements 94.47 %;
- build: `dist/extension.js` 434.8 KiB of 600, `dist/modelApi.js`
  297.1 KiB of 400;
- a11y: 336 pages, 0 rules violated; audit 0 advisories;
- gitleaks: no leaks; Semgrep: 287 rules on 416 files, 0 findings.

gitleaks and Semgrep read tracked files only. The two new fixtures and
their helper were scanned on their own first (`gitleaks dir`: no leaks),
and again after the commit.

With the third review round's fixes, `npm run quality` on the working tree
(Windows 11, 2026-09-27, after the drills, before the commit) exited 0:

- `check:l10n` 14 tables, 93 manifest strings, 0 problems; knip and dpdm
  clean; jscpd 0 clones; PSScriptAnalyzer 0 findings;
- vitest: 179 files passed and 2 skipped; 2,659 tests passed and 23
  skipped; statements 94.48 %;
- build: `dist/extension.js` 438.2 KiB of 600, `dist/modelApi.js`
  297.2 KiB of 400, the bundle-split check passed;
- a11y: 336 pages, 0 rules violated; audit 0 advisories;
- gitleaks: no leaks; Semgrep: 287 rules on 416 files, 0 findings.

The three new fixtures (`account-login-granted.json`, `-denied.json`,
`-failed.json`) and `test/unit/helpers/credentialShapes.ts` were untracked
during that run, so they were scanned on their own (`gitleaks dir`: no
leaks). The label and avatar address in the granted fixture are the
stand-ins `someone@example.com` and `https://example.com/avatar.png`.
