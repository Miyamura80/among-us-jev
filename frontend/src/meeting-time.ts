const TICK_REFERENCE = /\b(?:at\s+)?tick\s+(\d+)\b/gi

/** Display model-authored tick references relative to the current meeting. */
export function formatDiscussionTime(
  text: string,
  meetingStartTick: number | undefined,
  bodyReported: boolean,
): string {
  if (meetingStartTick === undefined) return text
  const anchor = bodyReported ? "the body was reported" : "the meeting"
  return text.replace(TICK_REFERENCE, (original, rawTick: string) => {
    const tick = Number(rawTick)
    if (!Number.isSafeInteger(tick)) return original
    const difference = tick - meetingStartTick
    if (difference === 0) return bodyReported ? "when the body was reported" : "when the meeting was called"
    const seconds = Math.abs(difference)
    const unit = seconds === 1 ? "second" : "seconds"
    return `${seconds} ${unit} ${difference < 0 ? "before" : "after"} ${anchor}`
  })
}
