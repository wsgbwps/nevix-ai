import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../../components/ui/dialog'
import { useActiveOrganization } from '../model/active-organization-state'

export function SessionAccessLostDialog(): React.JSX.Element | null {
  const { t } = useTranslation('organization')
  const { sessionAccessLostOrganization, acknowledgeSessionAccessLost } = useActiveOrganization()

  if (!sessionAccessLostOrganization) return null

  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {t('accessLost.title', { org: sessionAccessLostOrganization.organizationName })}
          </DialogTitle>
          <DialogDescription>{t('accessLost.description')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" onClick={acknowledgeSessionAccessLost}>
            {t('accessLost.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
