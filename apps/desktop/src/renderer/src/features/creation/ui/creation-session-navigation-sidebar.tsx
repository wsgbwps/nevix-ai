import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileImageIcon, MoreHorizontalIcon, PencilLineIcon } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../../../components/ui/dropdown-menu'
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem
} from '../../../components/ui/sidebar'
import type { CreationSessionView } from '../api/go-creation-http'
import type { PendingDraftEntry } from '../model/creation-session-navigation-controller'
import { useCreationSessionNavigation } from '../model/creation-session-navigation-context'
import { ComposerMenuContent } from './composer-menu-content'

const sessionIdentityColors = [
  'bg-sky-600 text-white',
  'bg-violet-600 text-white',
  'bg-emerald-600 text-white',
  'bg-amber-600 text-white',
  'bg-rose-600 text-white',
  'bg-cyan-700 text-white'
] as const

function sessionIdentityColor(id: string): (typeof sessionIdentityColors)[number] {
  let hash = 0
  for (const character of id) hash = (hash * 31 + character.codePointAt(0)!) >>> 0
  return sessionIdentityColors[hash % sessionIdentityColors.length]
}

function firstVisibleGrapheme(name: string): string | null {
  const visible = name.trim()
  if (visible.length === 0) return null
  if (typeof Intl.Segmenter === 'function') {
    return (
      new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(visible).containing(0)
        ?.segment ?? null
    )
  }
  return Array.from(visible)[0] ?? null
}

function SessionIdentity({
  session
}: {
  readonly session: CreationSessionView
}): React.JSX.Element {
  const monogram = firstVisibleGrapheme(session.name)
  return (
    <span
      aria-hidden
      data-testid={`session-identity-${session.id}`}
      className={`grid size-7 shrink-0 place-items-center rounded-md text-xs font-semibold ${sessionIdentityColor(session.id)}`}
    >
      {monogram ?? <FileImageIcon className="size-3.5" />}
    </span>
  )
}

function pendingStatus(status: PendingDraftEntry['status']): 'running' | 'unconfirmed' | 'failed' {
  if (status === 'preparing' || status === 'submitting') return 'running'
  if (status === 'failed') return 'failed'
  return 'unconfirmed'
}

function pendingStatusColor(status: ReturnType<typeof pendingStatus>): string {
  return status === 'running'
    ? 'bg-sky-500'
    : status === 'failed'
      ? 'bg-destructive'
      : 'bg-amber-500'
}

function PendingSessionRow({
  entry,
  selected,
  onSelect
}: {
  readonly entry: PendingDraftEntry
  readonly selected: boolean
  readonly onSelect: () => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const name = entry.title.length > 0 ? entry.title : String(t('sessions.unnamed'))
  const status = pendingStatus(entry.status)
  const statusLabel = String(t(`sessions.pendingStatus.${status}`))
  const tooltip = `${name} · ${statusLabel}`
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={selected}
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        aria-label={tooltip}
        tooltip={tooltip}
        data-testid={`session-pending-${entry.key}`}
      >
        <span className="bg-foreground/[0.06] text-foreground relative grid size-7 shrink-0 place-items-center rounded-md border">
          <PencilLineIcon className="size-3.5" aria-hidden />
          <span
            aria-hidden
            data-testid={`pending-session-status-${entry.key}`}
            data-pending-status={status}
            className={`border-sidebar absolute -right-0.5 -bottom-0.5 size-2 rounded-full border ${pendingStatusColor(status)}`}
          />
        </span>
        <span className="grid min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
          <span className="truncate text-xs font-medium">{name}</span>
          <span className="text-muted-foreground flex items-center gap-1 truncate text-[9px]">
            <span
              aria-hidden
              data-pending-status={status}
              className={`size-1.5 rounded-full ${pendingStatusColor(status)}`}
            />
            {statusLabel}
          </span>
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

function SessionRow({
  session,
  selected,
  onSelect,
  onDelete,
  onRename
}: {
  readonly session: CreationSessionView
  readonly selected: boolean
  readonly onSelect: () => void
  readonly onDelete: () => void
  readonly onRename: (name: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const name = session.name.length > 0 ? session.name : String(t('sessions.unnamed'))
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState('')
  const renameCancelled = useRef(false)

  const beginRename = (): void => {
    renameCancelled.current = false
    setDraftName(session.name)
    setRenaming(true)
  }
  const finishRename = (): void => {
    setRenaming(false)
    if (renameCancelled.current) return
    const next = draftName.trim()
    if (next !== session.name) onRename(next)
  }

  if (renaming) {
    return (
      <SidebarMenuItem>
        <form
          className="bg-sidebar-accent flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            finishRename()
          }}
        >
          <SessionIdentity session={session} />
          <input
            autoFocus
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={finishRename}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                renameCancelled.current = true
                setRenaming(false)
              }
            }}
            aria-label={t('sessions.rename.label')}
            maxLength={128}
            data-testid="session-rename-input"
            className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-xs font-medium outline-none"
          />
        </form>
      </SidebarMenuItem>
    )
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={selected}
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        aria-label={name}
        tooltip={name}
        data-testid={`session-${session.id}`}
      >
        <SessionIdentity session={session} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium group-data-[collapsible=icon]:hidden">
          {name}
        </span>
      </SidebarMenuButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction
            showOnHover
            aria-label={t('sessions.menu.open')}
            data-testid={`session-menu-${session.id}`}
          >
            <MoreHorizontalIcon className="size-4" aria-hidden />
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <ComposerMenuContent side="bottom" align="start" sideOffset={4}>
          <DropdownMenuItem onSelect={beginRename} data-testid={`session-rename-${session.id}`}>
            <PencilLineIcon className="size-3.5" aria-hidden />
            {t('sessions.menu.rename')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onDelete} data-testid={`session-delete-${session.id}`}>
            {t('sessions.menu.delete')}
          </DropdownMenuItem>
        </ComposerMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  )
}

/** The Creation-owned contribution composed into every authenticated App Shell. */
export function CreationSessionNavigationSidebar({
  onOpenCreation
}: {
  readonly onOpenCreation: () => void
}): React.JSX.Element | null {
  const navigation = useCreationSessionNavigation()
  const { t } = useTranslation('creation')
  if (navigation === null) return null

  const openNewDraft = (): void => {
    navigation.startNewDraft()
    onOpenCreation()
  }
  const openSession = (session: CreationSessionView): void => {
    navigation.selectSession(session)
    onOpenCreation()
  }
  const openPendingDraft = (key: string): void => {
    navigation.openPendingDraft(key)
    onOpenCreation()
  }

  return (
    <SidebarGroup
      aria-label={t('sessions.label')}
      className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden py-0"
      data-testid="creation-session-navigation"
    >
      <SidebarGroupLabel>{t('sessions.label')}</SidebarGroupLabel>
      <SidebarGroupContent className="flex min-h-0 flex-1 flex-col">
        <SidebarMenu className="shrink-0">
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={navigation.target.kind === 'new'}
              onClick={openNewDraft}
              tooltip={String(t('sessions.newAction'))}
              data-testid="session-new"
            >
              <PencilLineIcon />
              <span className="group-data-[collapsible=icon]:hidden">
                {t('sessions.newAction')}
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="min-h-0 flex-1 overflow-y-auto px-0.5 py-1" data-testid="session-list">
          {navigation.sessions.length === 0 &&
          navigation.pendingDrafts.length === 0 &&
          navigation.status === 'ready' ? (
            <p className="text-muted-foreground px-2 py-2 text-xs" role="status">
              {t('sessions.empty')}
            </p>
          ) : (
            <SidebarMenu>
              {navigation.pendingDrafts.map((entry) => (
                <PendingSessionRow
                  key={entry.key}
                  entry={entry}
                  selected={
                    navigation.target.kind === 'pending' && navigation.target.key === entry.key
                  }
                  onSelect={() => openPendingDraft(entry.key)}
                />
              ))}
              {navigation.sessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  selected={
                    navigation.target.kind === 'session' &&
                    navigation.target.session.id === session.id
                  }
                  onSelect={() => openSession(session)}
                  onDelete={() => navigation.deleteSession(session.id)}
                  onRename={(name) => navigation.renameSession(session.id, name)}
                />
              ))}
            </SidebarMenu>
          )}
          {navigation.status === 'loading' && (
            <p role="status" className="text-muted-foreground px-2 py-2 text-xs">
              {t('state.loading')}
            </p>
          )}
          {navigation.status === 'error' && (
            <div role="alert" className="grid gap-1 px-2 py-2">
              <p className="text-xs">{t('state.loadFailed')}</p>
              <button
                type="button"
                className="hover:bg-accent rounded border px-2 py-1 text-xs"
                onClick={navigation.reload}
              >
                {t('state.retry')}
              </button>
            </div>
          )}
        </div>
        <p className="text-muted-foreground shrink-0 border-t px-2 py-2 text-[9px] group-data-[collapsible=icon]:hidden">
          {t('sessions.private')}
        </p>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
