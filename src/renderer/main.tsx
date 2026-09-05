import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { handleBeforeUnload } from './closeGuard'
import './index.css'

window.addEventListener('beforeunload', handleBeforeUnload)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
