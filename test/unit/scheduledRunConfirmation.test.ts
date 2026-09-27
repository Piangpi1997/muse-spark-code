import { window } from 'vscode'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isScheduledRunConfirmed } from '../../src/host/paid/paidHost'
import { UI_TEXT } from '../../src/shared/constants'
import { paidFeaturePrice } from '../../src/shared/paid'

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
      detail: expect.stringContaining(paidFeaturePrice('scheduledPrompts')),
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
})
