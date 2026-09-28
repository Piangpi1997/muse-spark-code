// The verify loop in the transcript (M68, PLAN.md D49): the line under a
// "Check edits" or "Run checks" row (the edited files' errors and warnings,
// then how each check ended), its body, and an edit's `then_run` shown as
// the call's second result under its diff.

import type { ThenRunResult, VerifySummary } from '../../shared/agentEvents'
import { UI_TEXT } from '../../shared/constants'
import { fill, formatNumber, plural } from '../../shared/l10n/text'
import { Clipped } from './ToolBlocks'

const PART_SEPARATOR = ' · '

/** "2 errors, 1 warning · lint passed · test failed", or undefined for nothing to say. */
export function verifySummaryText(summary: VerifySummary | undefined): string | undefined {
  if (summary === undefined) {
    return undefined
  }
  const parts: string[] = []
  const { errors, warnings } = summary
  if (errors !== undefined && warnings !== undefined) {
    parts.push(
      errors === 0 && warnings === 0
        ? UI_TEXT.verifyClean
        : `${plural(UI_TEXT.verifyErrors, errors)}, ${plural(UI_TEXT.verifyWarnings, warnings)}`,
    )
  }
  for (const check of summary.checks) {
    parts.push(fill(UI_TEXT.checkOutcomes[check.outcome], { name: check.name }))
  }
  return parts.length === 0 ? undefined : parts.join(PART_SEPARATOR)
}

/** How a `then_run` command ended, in words. */
export function thenRunOutcomeText(result: ThenRunResult): string {
  if (result.outcome === 'notRun') {
    return fill(UI_TEXT.thenRunNotRun, {
      reason: result.skip === undefined ? '' : UI_TEXT.checkSkips[result.skip],
    })
  }
  if (result.outcome === 'timedOut') {
    return UI_TEXT.thenRunTimedOut
  }
  return result.outcome === 'cancelled' || result.exitCode === undefined
    ? UI_TEXT.toolStopped
    : fill(UI_TEXT.userShellExitCode, { code: formatNumber(result.exitCode) })
}

/** The check's output, as the model read it. */
export function VerifyBody({
  output,
  onOpen,
}: {
  readonly output: string
  readonly onOpen: () => void
}) {
  return output === '' ? null : <Clipped text={output} className="tool-output" onOpen={onOpen} />
}

/** An edit's `then_run`: the command, what it printed, and how it ended. */
export function ThenRunBlock({ result }: { readonly result: ThenRunResult }) {
  return (
    <div className="shell then-run">
      <div className="tool-detail-meta">{UI_TEXT.thenRunLabel}</div>
      <div className="shell-box">
        <span className="shell-label">{UI_TEXT.inLabel}</span>
        <pre className="tool-pre">{result.command}</pre>
      </div>
      {result.output === '' ? null : (
        <div className="shell-box">
          <span className="shell-label">{UI_TEXT.outLabel}</span>
          <Clipped text={result.output} className="shell-out" />
        </div>
      )}
      <p
        className={
          result.outcome === 'passed' ? 'tool-detail-meta' : 'tool-detail-meta then-run-failed'
        }
      >
        {thenRunOutcomeText(result)}
      </p>
    </div>
  )
}
