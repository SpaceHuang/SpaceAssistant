import React from 'react'
import ReactDOM from 'react-dom/client'
import { Provider } from 'react-redux'
import { store } from './store'
import App from './App'
import { ThemeProvider } from './theme/ThemeProvider'
import './i18n'
import './styles.css'

const rendererStartupStartedAt = performance.now()
let rendererFirstPaintReported = false
let firstPaintObserverAvailable = false

function reportRendererStartup(phase: string): void {
  console.info('[startup]', JSON.stringify({
    phase,
    durationMs: Math.max(0, Math.round(performance.now() - rendererStartupStartedAt)),
    outcome: 'ok'
  }))
}

function reportFirstPaint(): void {
  if (rendererFirstPaintReported) return
  rendererFirstPaintReported = true
  reportRendererStartup('renderer.start-to-first-paint')
}

if (typeof PerformanceObserver !== 'undefined') {
  try {
    const paintObserver = new PerformanceObserver((list) => {
      if (list.getEntries().some((entry) => entry.name === 'first-contentful-paint')) {
        reportFirstPaint()
        paintObserver.disconnect()
      }
    })
    firstPaintObserverAvailable = true
    paintObserver.observe({ type: 'paint', buffered: true })
  } catch {
    // Paint timing is not available in every embedded Chromium configuration.
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={store}>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </Provider>
  </React.StrictMode>
)

reportRendererStartup('renderer.start-to-react-render-scheduled')
requestAnimationFrame(() => requestAnimationFrame(() => {
  if (!rendererFirstPaintReported && !firstPaintObserverAvailable) reportFirstPaint()
}))
