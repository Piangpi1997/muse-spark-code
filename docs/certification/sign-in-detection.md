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

| Behaviour                                                                                                                                                                                                                                                                                                | Where                                                                                                 | Tests                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.json` is parsed for its structure only: schema version, any provider named, a Keychain `storage` lane. The schema drops every other field. A file over 64 KiB, a folder or a stat failure is not read.                                                                                             | `src/core/backends/musecode/credentialFile.ts`, `readCredentialFile` in `src/host/auth/cliAccount.ts` | `credentialFile.test.ts` (the captured shapes on each OS, six malformed files); `cliAccount.test.ts` (`readCredentialFile`)                          |
| No file, or the empty file a sign-out leaves, is signed out without a process. A file holding the credential is signed in.                                                                                                                                                                               | `CliAccount.signIn`                                                                                   | `cliAccount.test.ts`; `authService.test.ts` "AuthService over the CLI’s real credential file"; `cliAccount.e2e.test.ts`                              |
| A macOS pointer on macOS, or a file the structure cannot place, is asked of the CLI (`account/read` on a short-lived `experimentalApi` host). The answer is kept per path, size and mtime.                                                                                                               | `CliAccount.confirm`, `probeAccount`                                                                  | `cliAccount.test.ts` (cache by mtime and by size, one shared question, a failed answer asked again on a click); `cliAccount.e2e.test.ts` (one probe) |
| On macOS the CLI is asked only on a user action (Check again, sign-in, sign-out, Diagnostics), never on activation or panel open.                                                                                                                                                                        | `CliAccount.confirm`; `AuthService.refresh(isUserAction)`; the controller's `retryBackend`            | `cliAccount.test.ts`; `authService.test.ts` "when the CLI may be asked"; `conversationController.test.ts`                                            |
| A macOS pointer on Windows or Linux is a named error that gives the file's path; the browser sign-in is refused with the same text instead of starting a host that exits 3.                                                                                                                              | `AuthService.selectedSnapshot`, `signInWithCli`; `UI_TEXT.cliKeychainElsewhere`                       | `authService.test.ts` "a credential file Muse Code cannot start with"                                                                                |
| Sign-out goes through MSP `account/logout`, confirmed by `account/read`. `muse logout` in a terminal is the fallback. The logout hold ends once the file or the CLI shows no sign-in, even though the file stays.                                                                                        | `logOutAccount`; `AuthService.performSignOut`, `refresh`                                              | `accountHost.test.ts`; `authService.test.ts` (the rewritten former 845–853 case, the account/logout path, the fallback, the real-file cases); e2e    |
| The device sign-in succeeds on either of two signals: `account/read` turning `accountLogin` while polling; a new file that `account/read` does not contradict. A CLI that cannot answer `account/read` falls back to the file. `granted` was not captured, so it is not a signal (PR #49 review, below). | `runDeviceSignIn`                                                                                     | `deviceSignIn.test.ts` "how it ends"                                                                                                                 |
| `account/loginCompleted` ends the flow at once on any outcome but `granted`. The captured `expired` shows its own message. Any other word is shown as Muse Code sent it, in one message (`signInEnded`). The host's message goes to the log, clipped. A malformed ending keeps waiting.                  | `runDeviceSignIn`; `AuthService` (`signInExpired`, `signInEnded`)                                     | `deviceSignIn.test.ts`; `authService.test.ts` "how Muse Code ends a browser sign-in"; `cliAccount.e2e.test.ts` (the captured frames replayed)        |
| Cancel and the host's ending are noticed at once, even while an `account/read` goes unanswered: each poll and each wait races a stop signal. `account/loginCancel` is bounded at 2 s, then the host is closed anyway.                                                                                    | `runDeviceSignIn` (`untilStopped`, `cancelLogin`); `MUSE_LOGIN_CANCEL_TIMEOUT_MS`                     | `deviceSignIn.test.ts` "a CLI that stops answering"; `cliAccount.e2e.test.ts` (the fake leaves `account/read` unanswered)                            |
| The extension waits 11 minutes, past the captured 600 s code lifetime, so Muse Code's own `expired` ends an unapproved code. Before, it cancelled at 5 minutes a code the browser could still approve.                                                                                                   | `CREDENTIAL_POLL_TIMEOUT_MS`                                                                          | `deviceSignIn.test.ts` "waits past the captured code lifetime"                                                                                       |
| A Cancel pressed while the pre-check reads the file is kept: the controller exists before that read, and an aborted flow never starts.                                                                                                                                                                   | `AuthService.signInWithCli`                                                                           | `authService.test.ts` "cancels the running device flow" (it caught the regression during this work)                                                  |
| The account's `label` (an e-mail address) is dropped by the `account/read` parse and never logged.                                                                                                                                                                                                       | `accountStateSchema`                                                                                  | `accountHost.test.ts`; `deviceSignIn.test.ts`; `cliAccount.e2e.test.ts` (the fake CLI sends a label)                                                 |
| Diagnostics names the file's structure and the CLI's sign-in. On macOS it adds the Keychain item's presence (`security find-generic-password -s ai.meta.dev.credentials -a meta`, no `-g`/`-w`: exit 0 or 44).                                                                                           | `renderSupportReport`, `keychainItemPresence`, the Diagnostics command                                | `supportReport.test.ts`; `credentialFile.test.ts`                                                                                                    |

The fake CLI (`test/e2e/fake-muse/serve.mjs`) now echoes `experimentalApi`.
For a client that asked for it, it serves `account/read` from the
credential file under `XDG_CONFIG_HOME`. It serves `account/logout` by
rewriting that file as the empty one the CLI leaves.
`installFakeCredential` writes a stored login's structure (schema 1, one
provider, no secret) instead of `{"fake": true}`.

The fake also runs the device sign-in from the live captures below. It
reads `test/fixtures/msp/account-login-*.json` from `MUSE_FAKE_CAPTURES`:

- `account/loginStart` answers as captured;
- `MUSE_FAKE_LOGIN_ENDING` sends a capture's `loginCompleted` frame after
  `MUSE_FAKE_LOGIN_ENDING_MS`;
- `account/loginCancel` sends the captured `cancelled` ending, then
  `{cancelled: true}`, in the captured order;
- `MUSE_FAKE_ACCOUNT_READ=silentAfterStart` leaves `account/read`
  unanswered once the flow has started.

The unit tests read the same files through
`test/unit/helpers/accountLoginCapture.ts`.

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

**Not captured: `granted`, `denied` and `failed`.** Each needs a click on
the device page in the owner's signed-in Chrome, through Chrome Control.
The Chrome Control extension is disabled in that Chrome profile
(`Default`, `disable_reasons: [1]`, a user action), so the MCP tools could
not attach. Turning it back on changes the owner's browser, which is his
call. So:

- **No handler keeps a meaning built on those words.**
- **`granted`.** It does not end the flow and is not a sign-in. The flow
  goes on until `account/read` turns `accountLogin`, or a new file appears
  that it does not contradict.
- **Every other word.** It ends the flow at once. The panel shows one
  localized message with the word as Muse Code sent it (`signInEnded`,
  "Sign-in ended: {outcome}. …"). The host's message goes to the log.
- **Capturing them later.** Once Chrome Control can attach, the same script
  captures them: `node capture.mjs granted|denied|failed-dirfile out`.
  `failed-dirfile` puts a file where the config folder goes, so the save
  after an approval should fail. A `granted` run signs out through
  `account/logout` in the same home before the home is deleted.

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

| Drill | What was broken                                                                                          | Suites                   | Result                                                                                                                                   |
| ----- | -------------------------------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| R     | A poll waits for an unanswered `account/read` (the P2 race removed)                                      | deviceSignIn, e2e        | exit 1, 6 failed (4 unit, 2 e2e, each at its test timeout); first "ends at once on the host’s ending while account/read goes unanswered" |
| S     | The wait between polls does not notice Cancel                                                            | deviceSignIn             | exit 1, 1 failed: "notices Cancel during the wait between polls"                                                                         |
| T     | `loginCancel` waits the 30 s MSP deadline instead of 2 s                                                 | deviceSignIn             | exit 1, 2 failed; first "closes the host after Cancel even when loginCancel is never answered"                                           |
| U     | The captured `expired` loses its own meaning                                                             | deviceSignIn, e2e        | exit 1, 6 failed; first (e2e) "ends on the captured expired ending, shown the code as captured"                                          |
| V     | The captured `cancelled` loses its own meaning                                                           | deviceSignIn             | exit 1, 1 failed: "treats the captured cancellation ending as terminal"                                                                  |
| W     | An ending no capture covers keeps the flow waiting (the old rule)                                        | deviceSignIn             | exit 1, 5 failed; first "ends at once on denied, which no capture covers, as the CLI named it"                                           |
| X     | The uncaptured `granted` ends the flow like any other word                                               | deviceSignIn             | exit 1, 2 failed; first "takes an uncaptured granted for nothing: account/read decides"                                                  |
| Y     | Every ending shown with the `expired` text                                                               | authService              | exit 1, 3 failed; first "ends an uncaptured denied sign-in at once, signed out with its reason"                                          |
| Z     | The extension gives up at 5 minutes, before the captured code lifetime                                   | deviceSignIn             | exit 1, 1 failed: "waits past the captured code lifetime, so Muse Code ends an unapproved code itself"                                   |
| AA    | An ending that arrives before `loginStart` answers is taken for Cancel                                   | deviceSignIn             | exit 1, 1 failed: "ends on the host’s ending while loginStart is unanswered, with no code shown"                                         |
| AB    | The pre-flight account probe awaited without the flow's signal (the review of PR #49)                    | `authService.test.ts`    | exit 1, 1 failed: Cancel waited on a probe the CLI never answered                                                                        |
| AC    | Sign-out and the next sign-in rejoin a probe Cancel abandoned (the review of PR #49)                     | `cliAccount.test.ts`     | exit 1, 1 failed: the second question waited on the unanswered probe                                                                     |
| AD    | A file change counted as a sign-in after a stop, while a poll went unanswered (the review of PR #49)     | `deviceSignIn.test.ts`   | exit 1, 1 failed: the expired code was reported as a sign-in                                                                             |
| AE    | `account/read`'s uncaptured `credentialRequired: false` read as a keyless sign-in (the review of PR #49) | `cliAccount.test.ts`     | exit 1, 1 failed: a signed-out answer with the flag false became `signedIn`                                                              |
| AF    | The device flow's signed-out guard gated on `credentialRequired` again (the review of PR #49)            | `deviceSignIn.test.ts`   | exit 1, 1 failed: a rewritten file counted as a sign-in under the uncaptured value                                                       |
| AG    | An empty version-2 file read as a Keychain pointer off macOS (the review of PR #49)                      | `credentialFile.test.ts` | exit 1, 2 failed: a signed-out macOS file copied to Windows or Linux blocked browser sign-in                                             |

## Not proved here

A real sign-in is the owner's to give, and each of these needs one:

- **A 1.4.0 macOS device login.** It should write the Keychain item and a
  schema-2 pointer. The pointer's mtime should change on a same-account
  re-login, which is the device flow's third signal.
- **The success sequence, and `denied` and `failed`.** These are the order
  and timing of `account/loginCompleted {outcome: "granted"}` against
  `account/read`, `account/changed` and the file, and the frames of a
  declined code and a failed save. `cancelled` and `expired` were captured
  live (above). The other three need Chrome Control, whose extension is
  disabled in the owner's Chrome. Until then they have no handler of their
  own.
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
