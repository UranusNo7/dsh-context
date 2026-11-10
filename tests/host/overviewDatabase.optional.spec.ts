import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, test, vi } from 'vitest'

const failure = vi.hoisted(() => ({ mode: 'module' as 'module' | 'constructor' }))

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>()
  return {
    ...actual,
    createRequire: () => () => {
      if (failure.mode === 'module') throw new Error('node:sqlite unavailable')
      return { DatabaseSync: class { constructor() { throw new Error('cannot open database') } } }
    },
  }
})

import { openOverviewDatabase } from '../../src/host/overviewDatabase'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function pathOf(): string {
  mkdirSync(resolve('.tmp'), { recursive: true })
  const dir = mkdtempSync(join(resolve('.tmp'), 'optional-sqlite-'))
  dirs.push(dir)
  return join(dir, 'stats.sqlite')
}

test('an unavailable SQLite module leaves storage untouched and returns the fallback signal', () => {
  failure.mode = 'module'
  const path = pathOf()
  assert.equal(openOverviewDatabase({ path }), null)
  assert.equal(existsSync(path), false)
})

test('a failed SQLite constructor returns the fallback signal instead of breaking overview', () => {
  failure.mode = 'constructor'
  assert.equal(openOverviewDatabase({ path: pathOf() }), null)
})
