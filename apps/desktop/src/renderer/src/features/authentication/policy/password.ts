export const MINIMUM_PASSWORD_BYTES = 12
export const MAXIMUM_PASSWORD_BYTES = 72

const textEncoder = new TextEncoder()

export function passwordByteLength(password: string): number {
  return textEncoder.encode(password).byteLength
}

export function isPasswordByteLengthValid(password: string): boolean {
  const byteLength = passwordByteLength(password)
  return byteLength >= MINIMUM_PASSWORD_BYTES && byteLength <= MAXIMUM_PASSWORD_BYTES
}
