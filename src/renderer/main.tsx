import { createRoot } from 'react-dom/client'
import './styles/global.css'
import App from './App'

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(<App />)
}

// Temporary: verify scanner works (remove in Phase 4)
window.api.scanProjects().then((projects) => {
  console.log('scanProjects result:', projects)
})
