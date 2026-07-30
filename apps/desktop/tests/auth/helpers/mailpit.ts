interface MailpitHarnessConfig {
  readonly url: string
}

interface RegistrationMessage {
  readonly id: string
  readonly code: string
  readonly body: string
}

const REGISTRATION_CODE_PATTERN = /\b\d{6}\b/
const POLL_INTERVAL_MS = 200
const POLL_TIMEOUT_MS = 10_000

export function readMailpitHarnessConfig(): MailpitHarnessConfig | undefined {
  const url = process.env.NEVIX_TEST_MAILPIT_URL
  return url ? { url } : undefined
}

export async function readMailpitMessageIds(
  config: MailpitHarnessConfig
): Promise<readonly string[]> {
  return (await listMessages(config)).map((message) => message.id)
}

export async function waitForRegistrationMessage(
  config: MailpitHarnessConfig,
  excludedMessageIds: readonly string[]
): Promise<RegistrationMessage> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  let sawAnyMessage = false
  let sawNewMessage = false
  const excludedIds = new Set(excludedMessageIds)

  while (Date.now() < deadline) {
    const summaries = await listMessages(config)
    sawAnyMessage ||= summaries.length > 0
    const summary = summaries.find((candidate) => !excludedIds.has(candidate.id))

    if (summary) {
      sawNewMessage = true
      const body = await readMessageBody(config, summary.id)
      const code = body.match(REGISTRATION_CODE_PATTERN)?.[0]
      if (code) return { id: summary.id, code, body }
    }

    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }

  throw new Error(
    `Registration email was not captured before the bounded deadline (mailbox=${sawAnyMessage ? 'non-empty' : 'empty'}, new-message=${sawNewMessage ? 'missing-code' : 'missing'})`
  )
}

async function listMessages(config: MailpitHarnessConfig): Promise<readonly { id: string }[]> {
  const response = await fetch(
    `${config.url}/api/v1/messages?start=0&limit=50&request=${Date.now()}`,
    { cache: 'no-store' }
  )
  if (!response.ok) throw new Error('Unable to query the Mailpit test mailbox')

  const payload: unknown = await response.json()
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return []

  return payload.messages.flatMap((message) => {
    if (!isRecord(message)) return []

    const id = readString(message, 'id', 'ID')
    return id ? [{ id }] : []
  })
}

async function readMessageBody(config: MailpitHarnessConfig, messageId: string): Promise<string> {
  const response = await fetch(`${config.url}/api/v1/message/${encodeURIComponent(messageId)}`)
  if (!response.ok) throw new Error('Unable to read a Mailpit test message')

  const payload: unknown = await response.json()
  if (!isRecord(payload)) return ''

  return [readString(payload, 'text', 'Text'), readString(payload, 'html', 'HTML')]
    .filter((part): part is string => part !== undefined)
    .join('\n')
}

function readString(
  record: Record<string, unknown>,
  ...keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
