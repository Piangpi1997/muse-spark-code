## What and why

<!-- One paragraph: the change and the reason. Link the issue if there is one. -->

## Checklist

- [ ] Final staged tree passed `npm run quality`; commit tree matches it (record both hashes below).
- [ ] Independent pre-PR review completed; findings fixed and affected gates rerun.
- [ ] Staged changes scanned for secrets before commit; result recorded below.
- [ ] Manual branch CI passed all seven jobs on this commit before opening the PR (run ID and `headSha` below).
- [ ] Relevant Windows host/VM and other platform checks used this tree; failures and limits are recorded below.
- [ ] Tests added or changed with the code; a new check was seen to fail once on purpose.
- [ ] `CHANGELOG.md` updated under `Unreleased`; README and `docs/PRIVACY.md` where behaviour changed.
- [ ] No new dependency, suppressed rule or `any` without a reason here and, for suppressions, a row in PLAN.md §8.
- [ ] Nothing in the diff contains a credential.

## Pre-PR proof

- Tested `git write-tree`:
- Commit SHA and `git rev-parse HEAD^{tree}`:
- Independent review and red drills:
- Staged-change secret scan result:
- Local and VM results (state any unproved gate):
- Branch CI run ID, `headSha`, and seven job conclusions:

```
<!-- tail of `npm run quality` -->
```
