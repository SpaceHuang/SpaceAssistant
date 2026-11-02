'use strict'

// Test UI text and accessibility labels must be stable across hosted runner locales.
function configureCriticalFlowLocale(app) {
  app.commandLine.appendSwitch('lang', 'zh-CN')
}

module.exports = { configureCriticalFlowLocale }
