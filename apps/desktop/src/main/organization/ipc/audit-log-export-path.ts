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
