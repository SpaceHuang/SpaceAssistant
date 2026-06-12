import React from 'react'
import ReactDOM from 'react-dom/client'
import { FloatingNotificationApp } from './components/FloatingNotification/FloatingNotificationApp'

ReactDOM.createRoot(document.getElementById('floating-root')!).render(
  <React.StrictMode>
    <FloatingNotificationApp />
  </React.StrictMode>
)
