import '../../../src/renderer/src/app/globals.css'
import { Scrollbars } from '../../../src/renderer/src/app/scrollbars'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../../../src/renderer/src/components/ui/select'

export function ScrollbarsStory({
  documentScroll = false
}: {
  documentScroll?: boolean
}): React.JSX.Element {
  return (
    <>
      <Scrollbars />
      <div
        aria-label="Outer scroll area"
        tabIndex={0}
        style={{ width: 320, height: 240, overflow: 'auto', margin: 40 }}
      >
        <div style={{ width: 600, height: 1000, padding: 20 }}>
          <div
            aria-label="Inner scroll area"
            tabIndex={0}
            style={{ width: 160, height: 120, overflow: 'auto' }}
          >
            <div style={{ width: 300, height: 500 }}>Scrollable content</div>
          </div>
        </div>
      </div>
      <Select>
        <SelectTrigger aria-label="Scrollable select">
          <SelectValue placeholder="Choose an item" />
        </SelectTrigger>
        <SelectContent position="popper" style={{ maxHeight: 160 }}>
          {Array.from({ length: 40 }, (_, index) => (
            <SelectItem key={index} value={String(index)}>
              Item {index}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {documentScroll && <div style={{ width: 1800, height: 1200 }}>Document scroll content</div>}
    </>
  )
}
