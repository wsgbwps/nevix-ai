/**
 * The renderer's `connect-src` is runtime state: it is delivered as a response
 * header on the main document because a `meta` CSP is frozen at build time and
 * intersects (never relaxes) with headers. The static `meta` policy keeps
 * enforcing script/style/img/object/base/frame independently, so a failure of
 * this injection never opens those directives.
 */

export function rendererConnectSourceCsp(url: string | undefined, isDevelopment: boolean): string {
  const connectSource = [url, ...(isDevelopment ? ["'self'"] : [])].filter(Boolean)
  return `connect-src ${connectSource.length > 0 ? connectSource.join(' ') : "'none'"}`
}
