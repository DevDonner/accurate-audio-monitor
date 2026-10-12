// Dev harness entry: mounts the identical index.tsx the portfolio will mount.
import { createRoot } from 'react-dom/client'
import App from '../index.tsx'
import './index.css'

createRoot(document.getElementById('root')!).render(<App />)
