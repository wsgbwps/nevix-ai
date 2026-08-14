export const MINIMUM_PASSWORD_BYTES = 12
export const MAXIMUM_PASSWORD_BYTES = 72

export type PasswordByteLengthError = 'too-short' | 'too-long'

const textEncoder = new TextEncoder()

export function passwordByteLength(password: string): number {
  return textEncoder.encode(password).byteLength
}

export function isPasswordByteLengthValid(password: string): boolean {
  return passwordByteLengthError(password) === undefined
}

export function passwordByteLengthError(password: string): PasswordByteLengthError | undefined {
  const byteLength = passwordByteLength(password)
  if (byteLength < MINIMUM_PASSWORD_BYTES) return 'too-short'
  if (byteLength > MAXIMUM_PASSWORD_BYTES) return 'too-long'
  return undefined
}
