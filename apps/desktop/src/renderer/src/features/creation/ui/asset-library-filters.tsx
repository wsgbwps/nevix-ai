import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckIcon, ChevronDownIcon } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '../../../components/ui/dropdown-menu'
import { Input } from '../../../components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover'
import type { AssetMediaType, AssetSort } from '../api/asset-library-http'
import { isoDay, type AssetFilters } from '../model/use-asset-list'

const MEDIA_TYPES: readonly AssetMediaType[] = ['image', 'video']

const PRESETS = [
  { id: 'all', days: null, labelKey: 'assets.filters.all' },
  { id: 'week', days: 7, labelKey: 'assets.filters.presets.week' },
  { id: 'month', days: 30, labelKey: 'assets.filters.presets.month' },
  { id: 'quarter', days: 90, labelKey: 'assets.filters.presets.quarter' }
] as const

type PresetId = (typeof PRESETS)[number]['id']

function presetDay(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return isoDay(date)
}

const triggerClass =
  'group text-muted-foreground font-normal data-[state=open]:text-foreground data-[state=open]:bg-muted'
const chevronClass = 'size-3.5 opacity-70 transition-transform group-data-[state=open]:rotate-180'

export function AssetLibraryFilters({
  filters,
  onChange
}: {
  readonly filters: AssetFilters
  readonly onChange: (filters: AssetFilters) => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  return (
    <div data-testid="asset-filters" className="flex flex-wrap items-center gap-1">
      <div role="group" aria-label={t('assets.filters.media')} className="flex items-center gap-1">
        {MEDIA_TYPES.map((mediaType) => {
          const active = filters.mediaType === mediaType
          return (
            <Button
              key={mediaType}
              type="button"
              size="sm"
              variant={active ? 'secondary' : 'ghost'}
              aria-pressed={active}
              className={active ? '' : 'text-muted-foreground font-normal'}
              onClick={() => onChange({ ...filters, mediaType })}
            >
              {t(`assets.media.${mediaType}`)}
            </Button>
          )
        })}
      </div>
      <span className="bg-border mx-1 h-4 w-px" aria-hidden />
      <SearchFilter filters={filters} onChange={onChange} />
      <TimeFilter filters={filters} onChange={onChange} />
      <SortFilter filters={filters} onChange={onChange} />
    </div>
  )
}

function SearchFilter({
  filters,
  onChange
}: {
  readonly filters: AssetFilters
  readonly onChange: (filters: AssetFilters) => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(filters.search)
  const apply = (): void => {
    setOpen(false)
    onChange({ ...filters, search: draft })
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="ghost" className={triggerClass}>
          {t('assets.filters.filter')}
          <ChevronDownIcon className={chevronClass} aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 space-y-2 rounded-xl p-3">
        <Input
          aria-label={t('assets.filters.search')}
          placeholder={t('assets.filters.searchHint')}
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') apply()
          }}
        />
        <Button type="button" size="sm" className="w-full" onClick={apply}>
          {t('assets.filters.submit')}
        </Button>
      </PopoverContent>
    </Popover>
  )
}

function TimeFilter({
  filters,
  onChange
}: {
  readonly filters: AssetFilters
  readonly onChange: (filters: AssetFilters) => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const [preset, setPreset] = useState<PresetId | 'custom'>(() =>
    filters.createdSince || filters.createdUntil ? 'custom' : 'all'
  )
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="ghost" className={triggerClass}>
          {t('assets.filters.time')}
          <ChevronDownIcon className={chevronClass} aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 rounded-xl p-3">
        <div className="flex items-center gap-1.5">
          <DateField
            label={t('assets.filters.start')}
            value={filters.createdSince}
            max={filters.createdUntil || undefined}
            onChange={(createdSince) => {
              setPreset('custom')
              onChange({ ...filters, createdSince })
            }}
          />
          <span className="text-muted-foreground text-xs" aria-hidden>
            –
          </span>
          <DateField
            label={t('assets.filters.end')}
            value={filters.createdUntil}
            min={filters.createdSince || undefined}
            onChange={(createdUntil) => {
              setPreset('custom')
              onChange({ ...filters, createdUntil })
            }}
          />
        </div>
        <div className="bg-border -mx-3 my-2 h-px" aria-hidden />
        <fieldset className="space-y-0.5">
          <legend className="sr-only">{t('assets.filters.time')}</legend>
          {PRESETS.map((option) => (
            <label
              key={option.id}
              className="hover:bg-muted has-[:focus-visible]:ring-ring/50 flex cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-sm has-[:focus-visible]:ring-2"
            >
              <span>
                <input
                  type="radio"
                  name="asset-created-preset"
                  className="sr-only"
                  checked={preset === option.id}
                  onChange={() => {
                    setPreset(option.id)
                    onChange({
                      ...filters,
                      createdSince: option.days === null ? '' : presetDay(option.days),
                      createdUntil: ''
                    })
                  }}
                />
                {t(option.labelKey)}
              </span>
              {preset === option.id ? <CheckIcon className="size-4" aria-hidden /> : null}
            </label>
          ))}
        </fieldset>
      </PopoverContent>
    </Popover>
  )
}

function DateField({
  label,
  value,
  min,
  max,
  onChange
}: {
  readonly label: string
  readonly value: string
  readonly min?: string
  readonly max?: string
  readonly onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <label className="bg-muted focus-within:ring-ring/50 flex h-8 min-w-0 flex-1 items-center rounded-md px-2 focus-within:ring-2">
      <span className="sr-only">{label}</span>
      <input
        type="date"
        aria-label={label}
        value={value}
        min={min}
        max={max}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="w-full min-w-0 bg-transparent text-xs outline-none"
      />
    </label>
  )
}

function SortFilter({
  filters,
  onChange
}: {
  readonly filters: AssetFilters
  readonly onChange: (filters: AssetFilters) => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="sm" variant="ghost" className={triggerClass}>
          {t('assets.filters.sort')}
          <ChevronDownIcon className={chevronClass} aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-40 rounded-xl">
        <DropdownMenuLabel>{t('assets.filters.order')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={filters.sort}
          onValueChange={(sort) => onChange({ ...filters, sort: sort as AssetSort })}
        >
          <DropdownMenuRadioItem value="newest">{t('assets.filters.newest')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="oldest">{t('assets.filters.oldest')}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
