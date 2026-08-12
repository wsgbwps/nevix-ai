interface RendererWindow {
  readonly isDestroyed: () => boolean
}

interface RendererFrame {
  readonly url: string
}

/** True only for Nevix AI's live, top-level renderer document at its exact entry URL. */
export function isTrustedTopLevelRenderer({
  ownerWindow,
  senderFrame,
  mainFrame,
  trustedRendererUrl
}: {
  readonly ownerWindow: RendererWindow | null
  readonly senderFrame: RendererFrame | null
  readonly mainFrame: RendererFrame
  readonly trustedRendererUrl: string
}): boolean {
  return (
    ownerWindow !== null &&
    !ownerWindow.isDestroyed() &&
    senderFrame !== null &&
    senderFrame === mainFrame &&
    senderFrame.url === trustedRendererUrl
  )
}
