export const macOSLocalizationPaths = {
  en: 'en.lproj/InfoPlist.strings',
  'zh-CN': 'zh-Hans.lproj/InfoPlist.strings'
}

export const nsisInstallerLanguages = ['en_US', 'zh_CN']

const requiredMacOSPermissionKeys = [
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
  'NSDocumentsFolderUsageDescription',
  'NSDownloadsFolderUsageDescription'
]

// This verifier contract is consumed directly by Node and Playwright without a TypeScript runtime.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function missingMacOSPermissionKeys(localization) {
  return requiredMacOSPermissionKeys.filter((key) => {
    const match = new RegExp(`"${key}"\\s*=\\s*"([^"]*)";`).exec(localization)
    return !match || match[1].trim().length === 0
  })
}
