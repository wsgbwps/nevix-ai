import { AudioLinesIcon, ImageIcon, VideoIcon } from 'lucide-react'
import type { MaterialKind } from '../api/go-creation-http'

export function ReferenceKindIcon({
  kind,
  className
}: {
  readonly kind: MaterialKind
  readonly className?: string
}): React.JSX.Element {
  if (kind === 'video') return <VideoIcon className={className} aria-hidden />
  if (kind === 'audio') return <AudioLinesIcon className={className} aria-hidden />
  return <ImageIcon className={className} aria-hidden />
}
