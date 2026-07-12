import Database from 'better-sqlite3'

const dbPath = process.argv[2] || 'C:/Users/Space/AppData/Roaming/spaceassistant/spaceassistant-data.db'
const db = new Database(dbPath)
const row = db.prepare("SELECT value FROM configs WHERE key='config.wechat'").get()
console.log(row?.value ?? '(none)')
