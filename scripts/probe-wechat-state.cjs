const { app } = require('electron')
const Database = require('better-sqlite3')
const path = require('path')

app.whenReady().then(() => {
  const dbPath = path.join(app.getPath('userData'), 'spaceassistant-data.db')
  const db = new Database(dbPath)
  const row = db.prepare("SELECT value FROM configs WHERE key='config.wechat'").get()
  console.log('dbPath:', dbPath)
  console.log('wechat:', row?.value ?? '(none)')
  const wechatbot = path.join(app.getPath('userData'), 'wechatbot')
  const fs = require('fs')
  console.log('wechatbot exists:', fs.existsSync(wechatbot))
  if (fs.existsSync(wechatbot)) {
    console.log('wechatbot files:', fs.readdirSync(wechatbot, { recursive: true }))
  }
  const audit = path.join(app.getPath('userData'), 'logs', 'wechat-audit.log')
  console.log('audit exists:', fs.existsSync(audit))
  if (fs.existsSync(audit)) {
    const tail = fs.readFileSync(audit, 'utf8').trim().split('\n').slice(-5)
    console.log('audit tail:', tail.join('\n'))
  }
  app.quit()
})
