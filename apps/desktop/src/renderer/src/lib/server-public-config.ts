import {
  parseServerPublicConfig,
  type ServerPublicConfig
} from '../../../shared/config/server-public-config'

export function readServerPublicConfig(): ServerPublicConfig | undefined {
  return parseServerPublicConfig({
    url: __NEVIX_SERVER_URL__,
    policy: __NEVIX_SERVER_CONFIG_POLICY__
  })
}
