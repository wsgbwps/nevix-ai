import { ipcMain } from 'electron'
import { getInterfaceLanguage, getMainI18nEnvironment } from '../../i18n'

export function register(): void {
  ipcMain.handle('i18n:get-bootstrap', () => ({
    interfaceLanguage: getInterfaceLanguage(),
    environment: getMainI18nEnvironment()
  }))
}
