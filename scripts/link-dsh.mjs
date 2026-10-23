// Development only: link the DSH packages this plugin imports into node_modules,
// from a source checkout (packages/...) or an installed release (node_modules).
import { access, mkdir, rm, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const base = resolve(process.argv[2] ?? process.env.DSH_CHECKOUT ?? join(process.env.HOME, 'deepseek-harness'))
await mkdir(join(root, 'node_modules', '@deepseek-ai'), { recursive: true })
// dsh-session-format-v3-to-v4: tests check produced logs against the stored-format rules.
for (const [name, source] of [['dsh-llm', 'packages/llm/llm'], ['dsh-session', 'packages/core/session'], ['dsh-session-format-v3-to-v4', 'packages/core/session-format-v3-to-v4']]) {
  let target
  for (const candidate of [join(base, source), join(base, '@deepseek-ai', name), join(base, 'node_modules/@deepseek-ai', name)]) {
    try { await access(join(candidate, 'package.json')); target = candidate; break } catch {}
  }
  if (!target) throw new Error(`@deepseek-ai/${name} not found under ${base}`)
  const destination = join(root, 'node_modules', '@deepseek-ai', name)
  await rm(destination, { force: true })
  await symlink(target, destination)
  console.log(`Linked @deepseek-ai/${name} from ${target}`)
}
