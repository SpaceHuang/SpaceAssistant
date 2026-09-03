import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { lastInsertRowidToNumber, runInTransaction } from './sqliteStore'

function createConn(): DatabaseSync {
  const conn = new DatabaseSync(':memory:')
  conn.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
  return conn
}

function countItems(conn: DatabaseSync): number {
  return (conn.prepare('SELECT COUNT(*) AS c FROM items').get() as { c: number }).c
}

describe('runInTransaction（连接级事务入口）', () => {
  it('提交：回调正常返回时写入全部落盘', () => {
    const conn = createConn()
    const result = runInTransaction(conn, () => {
      conn.prepare('INSERT INTO items (value) VALUES (?)').run('a')
      conn.prepare('INSERT INTO items (value) VALUES (?)').run('b')
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(countItems(conn)).toBe(2)
    conn.close()
  })

  it('回滚：回调抛错时所有写入撤销并重新抛出原错误', () => {
    const conn = createConn()
    const boom = new Error('boom')
    expect(() =>
      runInTransaction(conn, () => {
        conn.prepare('INSERT INTO items (value) VALUES (?)').run('a')
        throw boom
      })
    ).toThrow(boom)
    expect(countItems(conn)).toBe(0)
    conn.close()
  })

  it('嵌套成功：内层 savepoint 与外层一起提交', () => {
    const conn = createConn()
    runInTransaction(conn, () => {
      conn.prepare('INSERT INTO items (value) VALUES (?)').run('outer')
      runInTransaction(conn, () => {
        conn.prepare('INSERT INTO items (value) VALUES (?)').run('inner')
      })
    })
    expect(countItems(conn)).toBe(2)
    conn.close()
  })

  it('嵌套回滚：内层抛错被外层捕获时仅内层写入撤销（savepoint 语义）', () => {
    const conn = createConn()
    runInTransaction(conn, () => {
      conn.prepare('INSERT INTO items (value) VALUES (?)').run('outer')
      expect(() =>
        runInTransaction(conn, () => {
          conn.prepare('INSERT INTO items (value) VALUES (?)').run('inner')
          throw new Error('inner failed')
        })
      ).toThrow('inner failed')
      conn.prepare('INSERT INTO items (value) VALUES (?)').run('outer2')
    })
    const values = (conn.prepare('SELECT value FROM items ORDER BY id').all() as Array<{ value: string }>).map(
      (r) => r.value
    )
    expect(values).toEqual(['outer', 'outer2'])
    conn.close()
  })

  it('嵌套回滚：内层抛错未被捕获时整体回滚', () => {
    const conn = createConn()
    expect(() =>
      runInTransaction(conn, () => {
        conn.prepare('INSERT INTO items (value) VALUES (?)').run('outer')
        runInTransaction(conn, () => {
          conn.prepare('INSERT INTO items (value) VALUES (?)').run('inner')
          throw new Error('inner failed')
        })
      })
    ).toThrow('inner failed')
    expect(countItems(conn)).toBe(0)
    conn.close()
  })

  it('关闭连接后不可继续使用', () => {
    const conn = createConn()
    conn.close()
    expect(() => runInTransaction(conn, () => undefined)).toThrow()
  })

  it('拒绝 thenable 回调：回滚写入并抛错', () => {
    const conn = createConn()
    expect(() =>
      runInTransaction(conn, () => {
        conn.prepare('INSERT INTO items (value) VALUES (?)').run('async-write')
        return Promise.resolve('nope') as unknown as void
      })
    ).toThrow(/thenable|Promise/i)
    expect(countItems(conn)).toBe(0)
    conn.close()
  })

  it('嵌套 savepoint 名单调递增且互不相同', () => {
    const conn = createConn()
    const seen: string[] = []
    runInTransaction(conn, () => {
      expect(() =>
        runInTransaction(conn, () => {
          throw new Error('first inner fails')
        })
      ).toThrow('first inner fails')
      // 第一个内层失败回滚后，第二个内层仍须使用新的 savepoint 名并成功
      runInTransaction(conn, () => {
        conn.prepare('INSERT INTO items (value) VALUES (?)').run('second inner')
        seen.push('second')
      })
    })
    expect(seen).toEqual(['second'])
    expect(countItems(conn)).toBe(1)
    conn.close()
  })
})

describe('lastInsertRowidToNumber（bigint → number 安全转换）', () => {
  it('普通 number 原样返回', () => {
    expect(lastInsertRowidToNumber(42)).toBe(42)
  })

  it('安全整数范围内的 bigint 转为 number', () => {
    expect(lastInsertRowidToNumber(BigInt(7))).toBe(7)
    expect(lastInsertRowidToNumber(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('超出安全整数范围抛错，不静默丢失精度', () => {
    expect(() => lastInsertRowidToNumber(BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1))).toThrow(/safe integer/i)
  })
})
