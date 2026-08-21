import '../../../../../app/globals.css'
import './prototype.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AssetLibraryPrototype } from './asset-library-prototype'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AssetLibraryPrototype />
  </StrictMode>
)
