/**
 * Packaging guard: every bare specifier the published artifact imports must be
 * declared in `dependencies` or `peerDependencies`.
 *
 * This exists because of a defect class that bit this package family three
 * times (`search-budget` 0.1.0, `credential-rotate` 0.1.1, and
 * `session-trigger` 0.1.0): the source imports a bare package, the repo's own
 * `node_modules` resolves it (workspace root, or a transitive of something
 * else), and `npm test` inside the repo passes — while a clean project that
 * installs the published tarball gets
 *
 *     Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/schemastery'
 *     imported from .../node_modules/@argszero/cordis-plugin-goal-progress-guard/lib/index.js
 *
 * The repo's own test run cannot see it, by construction: locally the specifier
 * resolves. The only witness is a scan of the *built* files against the
 * *published* manifest, which is what this test does.
 *
 * Both directions are checked: an undeclared import (the crash), and a declared
 * dependency nothing imports (a stale declaration that misleads installers).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Recursively collect files under `dir` whose name matches `keep`. */
async function collect(dir, keep) {
  const found = []
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return found }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...await collect(full, keep))
    else if (keep(entry.name)) found.push(full)
  }
  return found
}

/**
 * Extract every bare specifier from TypeScript/JavaScript source text.
 *
 * Matches the three import forms that create a runtime dependency —
 * `from '<spec>'`, `import '<spec>'`, and dynamic `import('<spec>')` — and keeps
 * only those that are neither relative nor absolute. `import type` and
 * `export type` are excluded, because a type-only import is erased and needs no
 * declaration at runtime.
 */
function bareSpecifiers(text) {
  const found = new Set()
  const runtime = text.replace(/^\s*(?:import|export)\s+type\b[^\n]*\n/gm, '')
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
  ]
  for (const pattern of patterns) {
    for (const match of runtime.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) continue
      found.add(specifier)
    }
  }
  return found
}

/** The package name a bare specifier belongs to (`@scope/name` or `name`). */
function packageOf(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

test('every bare import in the published artifact is declared in the manifest', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.peerDependenciesMeta ?? {}),
  ])

  const files = [
    ...await collect(join(root, 'lib'), name => name.endsWith('.js')),
    ...await collect(join(root, 'src'), name => name.endsWith('.ts')),
  ]
  assert.ok(files.length > 0, 'the scan must find files — a zero-file scan proves nothing')

  const imported = new Map()
  for (const file of files) {
    for (const specifier of bareSpecifiers(await readFile(file, 'utf8'))) {
      const pkg = packageOf(specifier)
      if (!imported.has(pkg)) imported.set(pkg, file)
    }
  }

  for (const [pkg, file] of imported) {
    assert.ok(declared.has(pkg), `${pkg} is imported by ${file} but not declared in dependencies/peerDependencies`)
  }
  // The reverse direction applies to `dependencies` only: those are what an
  // installer actually pays for, so one nothing imports is a stale declaration.
  // A peer is a compatibility contract with the host — this package legitimately
  // names `@deepseek-ai/cordis` without a value import, because the only Cordis
  // symbol it uses is a type.
  for (const pkg of Object.keys(manifest.dependencies ?? {})) {
    assert.ok(imported.has(pkg), `${pkg} is a dependency but nothing imports it — a stale declaration misleads installers`)
  }
  // The published artifact's runtime import list, stated exactly. `@deepseek-ai/cordis`
  // is absent on purpose: only its `Context` type is used, and a type-only import
  // is erased — which is what keeps the peer declaration a compatibility contract
  // rather than a load-time requirement.
  assert.deepEqual([...imported.keys()].sort(), ['@deepseek-ai/schemastery'])
})

test('the manifest publishes exactly the files the loader needs', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.main, 'lib/index.js')
  assert.deepEqual(manifest.dsh, { bundle: { patch: './cordis.patch.yml' } })
  assert.ok(manifest.files.includes('cordis.patch.yml'), 'the bundle patch must ship, or mounting by name cannot work')
})

test('the bundle patch names this package and its own id', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const patch = await readFile(join(root, manifest.dsh.bundle.patch), 'utf8')
  assert.match(patch, new RegExp(`name: '${manifest.name.replace(/[/@.]/g, '\\$&')}'`))
  const { name } = await import('../lib/index.js')
  assert.match(patch, new RegExp(`- id: ${name}\\b`), 'the patch id and the plugin name must agree')
})
