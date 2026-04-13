import { createRoot } from 'react-dom/client'
import './styles/global.css'
import './styles/swim-lanes.css'
import SwimLanesApp from './SwimLanesApp'

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(<SwimLanesApp />)
}
