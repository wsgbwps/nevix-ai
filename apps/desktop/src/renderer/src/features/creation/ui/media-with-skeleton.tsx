import { useState } from 'react'
import { Skeleton } from '../../../components/ui/skeleton'
import { cn } from '../../../lib/utils'

type ImageWithSkeletonProps = Omit<React.ComponentProps<'img'>, 'src'> & {
  readonly src: string | null
  readonly loadingLabel: string
}

export function ImageWithSkeleton({
  src,
  loadingLabel,
  className,
  onLoad,
  ...props
}: ImageWithSkeletonProps): React.JSX.Element {
  const [loadedSource, setLoadedSource] = useState<string | null>(null)
  const loaded = src !== null && loadedSource === src

  return (
    <>
      {!loaded && (
        <>
          <Skeleton aria-hidden className="absolute inset-0 size-full rounded-none" />
          <span role="status" className="sr-only">
            {loadingLabel}
          </span>
        </>
      )}
      {src !== null && (
        <img
          {...props}
          src={src}
          className={cn(className, !loaded && 'invisible')}
          onLoad={(event) => {
            setLoadedSource(src)
            onLoad?.(event)
          }}
        />
      )}
    </>
  )
}

type VideoWithSkeletonProps = Omit<React.ComponentProps<'video'>, 'src'> & {
  readonly src: string
  readonly loadingLabel: string
}

export function VideoWithSkeleton({
  src,
  loadingLabel,
  className,
  onLoadedData,
  ...props
}: VideoWithSkeletonProps): React.JSX.Element {
  const [loadedSource, setLoadedSource] = useState<string | null>(null)
  const loaded = loadedSource === src

  return (
    <>
      {!loaded && (
        <>
          <Skeleton aria-hidden className="absolute inset-0 size-full rounded-none" />
          <span role="status" className="sr-only">
            {loadingLabel}
          </span>
        </>
      )}
      <video
        {...props}
        src={src}
        className={cn(className, !loaded && 'invisible')}
        onLoadedData={(event) => {
          setLoadedSource(src)
          onLoadedData?.(event)
        }}
      />
    </>
  )
}
