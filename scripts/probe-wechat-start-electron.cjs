const { app } = require('electron')
const path = require('path')

app.whenReady().then(async () => {
  const userData = app.getPath('userData')
  const wechatbot = path.join(userData, 'wechatbot')
  console.log('userData:', userData)
  console.log('wechatbot exists:', require('fs').existsSync(wechatbot))

  try {
    const { WeChatBot } = await import('@wechatbot/wechatbot')
    const bot = new WeChatBot({ storageDir: wechatbot, logLevel: 'info' })
    bot.on('error', (err) => console.error('bot error event:', err))
    bot.on('poll:start', () => console.log('poll:start'))
    bot.on('session:expired', () => console.log('session:expired'))
    const creds = await bot.login()
    console.log('login ok:', creds.accountId)
    const startPromise = bot.start()
    setTimeout(() => {
      console.log('isRunning after 3s:', bot.isRunning)
      bot.stop()
      app.quit()
    }, 3000)
    await startPromise.catch((e) => {
      console.error('startPoll failed:', e instanceof Error ? e.message : e)
      app.quit()
    })
  } catch (e) {
    console.error('login/start failed:', e instanceof Error ? e.message : e)
    app.quit()
  }
})
