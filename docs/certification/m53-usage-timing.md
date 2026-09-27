# M53 follow-up certification — Account & usage reset accuracy

Status: focused implementation complete on isolated branch
`codex/usage-timing`. This patch joins M53 after M52; no full local or
hosted certification is claimed here.

## Authority

- Meta's [Muse Code subscription documentation](https://dev.meta.ai/docs/muse-code/subscriptions)
  names Everyday's five-hour allowance, High's 5× and Power's 20× usage,
  but provides no weekly reset schedule or model-specific quota conversion.
- Installed `@muse-code/sdk` 1.3.0 defines one `SubscriptionUsage` with
  `observedAtMs`, an opaque `tier`, a window and a weekly block. Both
  `resetsAtMs` fields are epoch milliseconds, normalized from the provider.
- The live M8 frame in `docs/certification/m8.md` observed
  `1790108487971`, with window reset `1790126464000` (300 minutes)
  and weekly reset `1790553600000`; these timestamps remain unmodified.
- The owner's 2026-09-26 Muse-account Upgrade screenshot instead lists
  Power at $16/month with 500M weekly Muse tokens and Maximum at $80/month
  with 3B weekly Muse tokens. It is account-specific evidence for that
  Upgrade screen, not proof that those grants govern the Muse Code CLI's
  `usage/read` payload. Neither product UI nor this fix maps its opaque
  `tier` ID to those names or token budgets.
- A read-only probe against the installed Muse Code 1.3.0-R3401.1 CLI on
  2026-09-26 initialized `muse serve`, called only `usage/read`, and closed
  its child. It returned `{}` (no usage). No session was started and no
  model turn was made. That is consistent with M8's observation that the
  CLI does not report usage until a reply; it cannot identify this account's
  current weekly grant or verify the Upgrade screenshot's applicability.

## Acceptance and evidence

- Before code, the focused suite failed six intended assertions: the open
  modal clock stayed frozen, an expired row said `resets in now`, sign-out
  retained the prior account report, an empty new-host read reused its old
  snapshot, an older delayed read replaced a newer event, and a stopped
  host's delayed read posted its old usage. The test MSP server held real
  responses until after the newer event or host stop.
- A seventh red assertion showed that an empty `usage/read` on the same
  live host still revived an older frame. The correction clears it; an
  empty read begun before a newer `usage/changed` is ignored.
- After code, 277/277 focused tests passed. The modal tests cover both
  countdowns updating each minute, independent expiry of the five-hour
  and weekly rows, and timer cleanup on unmount. The reducer tests cover
  sign-out, backend change, unchanged provider usage after model selection,
  and opaque tiers with verbatim percentages and reset times.
- All five TypeScript projects, ESLint JS, Prettier for edited files, and
  `check:l10n` for all 14 tables passed locally. The exact integrated
  M53 quality and hosted CI results remain open before any PR claim.

No live subscription turn or paid Model API call is needed for this fix.
