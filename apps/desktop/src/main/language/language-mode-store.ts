import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  DEFAULT_LANGUAGE_MODE,
  isLanguageMode,
  type LanguageMode
} from '../../shared/i18n/language-mode'

const LANGUAGE_MODE_FILE_NAME = 'language-mode.json'

export async function loadLanguageMode(): Promise<LanguageMode> {
  try {
    const contents = await readFile(getLanguageModePath(), 'utf8')
    const storedValue: unknown = JSON.parse(contents)
    if (
      typeof storedValue === 'object' &&
      storedValue !== null &&
      'languageMode' in storedValue &&
      isLanguageMode(storedValue.languageMode)
    ) {
      return storedValue.languageMode
    }
  } catch {
    // A missing or invalid local setting intentionally falls back to the default.
  }

  return DEFAULT_LANGUAGE_MODE
}

export async function saveLanguageMode(languageMode: LanguageMode): Promise<void> {
  const languageModePath = getLanguageModePath()
  await mkdir(dirname(languageModePath), { recursive: true })
  await writeFile(languageModePath, JSON.stringify({ languageMode }), 'utf8')
}

function getLanguageModePath(): string {
  return join(app.getPath('userData'), LANGUAGE_MODE_FILE_NAME)
}
