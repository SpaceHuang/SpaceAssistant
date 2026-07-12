const { app } = require('electron')
const Database = require('better-sqlite3')
const path = require('path')

app.setName('spaceassistant')

app.whenReady().then(async () => {
  const userData = app.getPath('userData')
  const dbPath = path.join(userData, 'spaceassistant-data.db')
  console.log('userData:', userData)
  const db = new Database(dbPath)
  const row = db.prepare("SELECT value FROM configs WHERE key='config.wechat'").get()
  console.log('wechat:', row?.value ?? '(none)')
  const fs = require('fs')
  const wechatbot = path.join(userData, 'wechatbot')
  console.log('wechatbot exists:', fs.existsSync(wechatbot))

  try {
    const { WeChatBot } = await import('@wechatbot/wechatbot')
    const bot = new WeChatBot({ storageDir: wechatbot, logLevel: 'info' })
    bot.on('error', (err) => console.error('bot error event:', err))
    bot.on('poll:start', () => console.log('poll:start'))
    bot.on('session:expired', () => console.log('session:expired'))
    const creds = await bot.login()
    console.log('login ok:', creds.accountId)
    await bot.start()
    console.log('start ok, running:', bot.isRunning)
    bot.stop()
  } catch (e) {
    console.error('startPoll failed:', e instanceof Error ? e.stack || e.message : e)
  }
  app.quit()
})
