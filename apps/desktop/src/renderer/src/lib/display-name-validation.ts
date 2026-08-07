export type DisplayNameValidation = 'required' | 'too-long'

export function validateDisplayName(value: string): DisplayNameValidation | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0) return 'required'
  if (trimmed.length > 50) return 'too-long'
  return undefined
}
