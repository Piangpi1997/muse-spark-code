import { window } from 'vscode'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isScheduledRunConfirmed } from '../../src/host/paid/paidHost'
import { UI_TEXT } from '../../src/shared/constants'
import { scheduledRunPrice } from '../../src/shared/paid'

afterEach(() => {
  vi.mocked(window.showWarningMessage).mockReset()
})

describe('scheduled run native price confirmation (M52)', () => {
  it('names model, prompt and price, then refuses a closed dialog', async () => {
    vi.mocked(window.showWarningMessage).mockResolvedValueOnce(undefined)
    const isAccepted = await isScheduledRunConfirmed(
      { prompt: 'Review private tests' },
      'muse-spark-1.3',
    )
    expect(isAccepted).toBe(false)
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('muse-spark-1.3'),
      expect.objectContaining({
        modal: true,
        detail: expect.stringContaining('Review private tests'),
      }),
      UI_TEXT.scheduleRunConfirmAccept,
    )
    const options = vi.mocked(window.showWarningMessage).mock.calls[0]?.[1]
    expect(options).toMatchObject({
      detail: expect.stringContaining(scheduledRunPrice('muse-spark-1.3')),
    })
  })

  it('accepts only the named one-time choice', async () => {
    vi.mocked(window.showWarningMessage).mockImplementationOnce((_message, _options, ...items) =>
      Promise.resolve(items[0]),
    )
    await expect(
      isScheduledRunConfirmed({ prompt: 'Review tests' }, 'muse-spark-1.3'),
    ).resolves.toBe(true)
  })

  it('quotes only the selected contributor model rates, including the cached rate', async () => {
    vi.mocked(window.showWarningMessage).mockResolvedValueOnce(undefined)
    await expect(
      isScheduledRunConfirmed({ prompt: 'Review tests' }, 'muse-spark-1.3-contributor'),
    ).resolves.toBe(false)
    const detail = vi.mocked(window.showWarningMessage).mock.calls[0]?.[1]?.detail
    expect(detail).toContain('$0.100/1M input')
    expect(detail).toContain('$0.002/1M cached input')
    expect(detail).toContain('$0.200/1M output')
    expect(detail).not.toContain('$1.250/1M input')
  })

  it('refuses a model without verified rates before any modal', async () => {
    await expect(
      isScheduledRunConfirmed({ prompt: 'Review tests' }, 'muse-spark-future'),
    ).rejects.toThrow(UI_TEXT.subagentTariffUnknown)
    expect(window.showWarningMessage).not.toHaveBeenCalled()
  })
})
