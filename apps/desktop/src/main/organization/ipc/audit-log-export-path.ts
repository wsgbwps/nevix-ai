export function resolveAuditLogE2EOutputPath({
  e2eMode,
  isPackaged,
  configuredOutputPath
}: {
  readonly e2eMode: string | undefined
  readonly isPackaged: boolean
  readonly configuredOutputPath: string | undefined
}): string | undefined {
  if (e2eMode !== '1' || isPackaged) return undefined
  return configuredOutputPath && configuredOutputPath.length > 0 ? configuredOutputPath : undefined
}

export function resolveAuditLogE2ECancelDelay({
  e2eMode,
  isPackaged,
  configuredDelayMs
}: {
  readonly e2eMode: string | undefined
  readonly isPackaged: boolean
  readonly configuredDelayMs: string | undefined
}): number | undefined {
  if (e2eMode !== '1' || isPackaged) return undefined

  const delayMs = Number(configuredDelayMs)
  return Number.isInteger(delayMs) && delayMs > 0 && delayMs <= 10_000 ? delayMs : undefined
}
