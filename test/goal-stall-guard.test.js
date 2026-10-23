import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '@deepseek-ai/dsh-session'
import { createSystemMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { assertReleasedV4Relationships } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { apply } from '../index.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 10))

/** A real DSH Session behind a minimal agent and plugin context. */
function harness() {
  const session = Session.create('s1')
  const listeners = new Map()
  const contexts = new Map()
  const commands = new Map()
  const blocked = []
  let goal = { id: 'g', revision: 1, phase: 'active' }
  let turn = 0
  let emitting = false
  const emit = (name, ...args) => {
    const outer = emitting
    if (name === 'session/event') emitting = true
    try { for (const fn of listeners.get(name) ?? []) fn(...args) } finally { emitting = outer }
  }
  const append = (type, data, opts) => { session.append(type, data, opts); emit('session/event', session, session.snapshotEvents().at(-1)) }
  const agent = { id: 's1', session, status: 'idle' }
  const ctx = {
    logger: { warn() {} },
    agents: { get: id => (id === 's1' ? agent : undefined) },
    goals: {
      get: () => goal,
      block(target, ref, reason) {
        if (emitting) throw new Error('session append cannot reenter')
        blocked.push(reason)
        goal = { ...goal, phase: 'blocked', revision: goal.revision + 1 }
      },
    },
    systemPrompt: { context: c => { contexts.set(c.name, c); return () => {} } },
    commands: {
      register(def) { commands.set(def.name, def); return () => {} },
      async execute(target, line) {
        const [, name, rawInput] = line.match(/^\/(\S+)\s?([\s\S]*)$/)
        const id = `cmd-${commands.size}-${Math.random()}`
        append('command/run', { commandId: id, name, source: { kind: 'user' } })
        const result = await commands.get(name).handler({ agent: target, rawInput })
        append('command/done', { commandId: id, kind: result.kind, text: result.text })
      },
    },
    effect: fn => fn(),
    on(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]); return () => {} },
  }
  apply(ctx)
  const round = async ({ tools = false, source = 'goal' } = {}) => {
    turn++
    append('turn/start', { turn })
    append('step/start', { turn, step: 1 })
    if (turn === 1) append('system/message', { message: createSystemMessage('SYS'), turn, step: 1 }, { surfaceOp: 'append' })
    append('user/message', createUserMessage({ content: [{ type: 'text', text: `${source} ${turn}` }], source: { kind: source } }), { surfaceOp: 'append' })
    const reply = (step, content) => append('assistant/message', { turn, step, message: { id: `a${turn}-${step}`, role: 'assistant', content, source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] }, { surfaceOp: 'append' })
    if (tools) {
      const id = `call-${turn}`
      reply(1, [{ type: 'tool-call', id, name: 'bash', arguments: '{}' }])
      append('tool/call', { turn, step: 1, callId: id, name: 'bash', arguments: '{}' })
      append('tool/result', { turn, step: 1, message: createToolResultMessage({ callId: id, content: [{ type: 'text', text: 'ok' }], isError: false }) }, { surfaceOp: 'append' })
      append('step/end', { turn, step: 1 })
      append('step/start', { turn, step: 2 })
      reply(2, [{ type: 'text', text: `work ${turn}` }])
      append('step/end', { turn, step: 2 })
    } else {
      reply(1, [{ type: 'text', text: `status ${turn}` }])
      append('step/end', { turn, step: 1 })
    }
    append('turn/end', { turn, reason: { kind: 'completed' } })
    emit('agent/status', { agent, status: 'idle' })
    await tick()
  }
  return {
    session, agent, blocked, round,
    note: () => contexts.get('goal-stall-guard').text({ scope: agent }),
    cards: () => session.snapshotEvents().filter(e => e.type === 'command/done').map(e => e.data.text),
    visible: () => session.deriveMessages().map(m => m.content.map(b => b.text).join('')),
    resume: () => { goal = { ...goal, phase: 'active' }; emit('goal/changed', { agent, change: { operation: 'resume' } }) },
    storable() { const events = session.snapshotEvents(); assertReleasedV4Relationships({ header: { id: 's1', version: 4 }, events, inheritedEventCount: 0 }, new Set(events.map(e => e.type))) },
  }
}

test('three idle goal rounds bring a note and hide all but the latest of them', async () => {
  const h = harness()
  await h.round({ tools: true })
  for (let i = 0; i < 3; i++) await h.round()
  assert.match(h.note(), /last 3 goal rounds ended without any tool call/)
  assert.match(h.cards().at(-1), /^⏸ goal の空回りを検知.*turn 2〜3/)
  const visible = h.visible()
  assert.ok(!visible.includes('status 2') && !visible.includes('status 3'))
  assert.ok(visible.includes('status 4'), 'the latest round stays')
  h.storable()
})

test('a round with tool calls clears the note; idle rounds after the note block the goal', async () => {
  const h = harness()
  for (let i = 0; i < 3; i++) await h.round()
  await h.round({ tools: true })
  assert.equal(h.note(), '')
  for (let i = 0; i < 3; i++) await h.round()
  assert.notEqual(h.note(), '')
  for (let i = 0; i < 2; i++) await h.round()
  assert.equal(h.blocked.length, 0)
  await h.round()
  assert.equal(h.blocked.length, 1)
  assert.equal(h.blocked[0].code, 'no-progress')
  assert.match(h.cards().at(-1), /^⛔ goal を停止/)
  assert.equal(h.note(), '')
  h.storable()
})

test('user turns and a resumed goal start the count again', async () => {
  const h = harness()
  for (let i = 0; i < 2; i++) await h.round()
  await h.round({ source: 'user' })
  for (let i = 0; i < 2; i++) await h.round()
  assert.equal(h.note(), '')
  await h.round()
  assert.notEqual(h.note(), '')
  h.resume()
  assert.equal(h.note(), '')
})
