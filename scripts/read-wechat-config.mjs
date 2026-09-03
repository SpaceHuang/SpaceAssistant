import { DatabaseSync } from 'node:sqlite'

const dbPath = process.argv[2] || 'C:/Users/Space/AppData/Roaming/spaceassistant/spaceassistant-data.db'
const db = new DatabaseSync(dbPath)
const row = db.prepare("SELECT value FROM configs WHERE key='config.wechat'").get()
console.log(row?.value ?? '(none)')
