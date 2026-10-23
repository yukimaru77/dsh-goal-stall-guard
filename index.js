// Goal rounds that make no progress: a round that ends without a single tool
// call only restates status, and a round whose every tool call repeats one from
// the last few rounds (re-running the same checks) only re-confirms it. After a few such rounds in a row the next round
// gets a note asking for a concrete action or a decision on the goal, and the
// idle rounds are hidden from the model (the log keeps them). If the rounds
// stay idle after that, the goal is blocked and the user is told.
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'goal-stall-guard'
export const inject = ['agents', 'goals', 'systemPrompt', 'commands']

export const DEFAULTS = {
  // Idle goal rounds in a row before the note.
  nudgeAfterRounds: 3,
  // Further idle rounds after the note before the goal is blocked.
  blockAfterRounds: 3,
}

const OMITTED_SOURCE = 'goal-stall-omitted'
/** Earlier rounds a call is compared with. */
const REPEAT_WINDOW = 3

/** Calls that only read back results; they are not progress on their own. */
const READ_BACK = new Set(['job_output', 'job_list', 'get_goal', 'monitor_list'])
/** Arguments that label or schedule a call without changing what it does. */
const NOISE_ARGS = new Set(['description', 'justification', 'timeoutMs', 'timeout_ms', 'yield_time_ms', 'run_in_background', 'wait'])

/** The identity of one tool call: its name and its arguments, minus labels and scheduling. */
export function callKey(block) {
  let args = block.arguments
  if (typeof args === 'string') { try { args = JSON.parse(args) } catch { return `${block.name}\u0000${args}` } }
  const kept = args && typeof args === 'object' && !Array.isArray(args)
    ? Object.fromEntries(Object.keys(args).filter(key => !NOISE_ARGS.has(key)).sort().map(key => [key, args[key]]))
    : args
  return `${block.name}\u0000${JSON.stringify(kept)}`
}

/** Whether a round made no progress: no tool call, or only read-backs and calls repeated from the previous rounds. */
export function isIdleRound(calls, previous) {
  const seen = new Set(previous.flat())
  return calls.every(call => READ_BACK.has(call.slice(0, call.indexOf('\u0000'))) || seen.has(call))
}

/**
 * Goal rounds in a log that ended without any tool call (and without a user
 * prompt in the same turn): their goal prompts and replies, by turn.
 * @param events - the whole session log.
 */
export function idleRounds(events) {
  const turns = new Map()
  const recent = []
  let current
  for (const event of events) {
    if (event.type === 'turn/start') { current = { turn: event.data.turn, goal: false, user: false, calls: [], seqs: [] }; continue }
    if (!current) continue
    if (event.type === 'user/message' && event.surfaceOp === 'append') {
      if (event.data.source?.kind === 'goal') { current.goal = true; current.seqs.push(event.seq) }
      else if (event.data.source?.kind === 'user') current.user = true
    } else if (event.type === 'assistant/message') {
      current.seqs.push(event.seq)
      for (const block of event.data.message?.content ?? []) if (block?.type === 'tool-call') current.calls.push(callKey(block))
    } else if (event.type === 'turn/end') {
      if (current.goal && !current.user && event.data.reason?.kind === 'completed') {
        if (isIdleRound(current.calls, recent)) turns.set(current.turn, current)
        recent.push(current.calls)
        if (recent.length > REPEAT_WINDOW) recent.shift()
      } else if (current.user) recent.length = 0
      current = undefined
    }
  }
  return [...turns.values()]
}
const CARD_COMMAND = 'goal-stall'

/** The note added to the runtime context of the rounds after a stall was noticed. */
export function renderStallNote(rounds) {
  return [
    '<goal-progress>',
    `The last ${rounds} goal rounds made no progress: each ended without a tool call or only re-ran checks already run in the rounds before, then restated the status. Those rounds are hidden from the history. Re-running the same checks is not progress.`,
    'In this round, either take the next concrete step toward the objective that has not been done yet (name it, then do it with tools), or settle the goal: mark it complete with update_goal if the objective is met, or mark it blocked with the specific reason it cannot advance.',
    '</goal-progress>',
  ].join('\n')
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  const states = new Map()
  const log = (message) => ctx.logger?.warn?.(`goal-stall-guard: ${message}`)

  const stateFor = (agent) => {
    let state = states.get(agent)
    if (!state) {
      state = { round: undefined, idle: [], nudged: false, pending: undefined, recent: [] }
      states.set(agent, state)
    }
    return state
  }
  const reset = (state) => { state.idle = []; state.nudged = false; state.pending = undefined; state.recent = [] }

  ctx.effect(() => ctx.commands.register({
    name: CARD_COMMAND,
    description: 'Marker: a note about goal rounds without progress (added by goal-stall-guard)',
    recordInput: false,
    handler: ({ rawInput }) => ({ kind: 'success', text: rawInput.trim() }),
  }))

  async function card(agent, text) {
    try {
      await ctx.commands.execute(agent, `/${CARD_COMMAND} ${text}`, [], new AbortController().signal)
    } catch (error) { log(`could not add a card: ${error instanceof Error ? error.message : String(error)}`) }
  }

  /** Replace the given visible nodes with one placeholder per adjacent run. */
  function hide(agent, seqs) {
    const wanted = new Set(seqs)
    const nodes = [...(agent.session.surface?.nodes ?? [])]
    const runs = []
    let open = false
    for (const seq of nodes) {
      if (!wanted.has(seq)) { open = false; continue }
      if (open) runs.at(-1).push(seq)
      else runs.push([seq])
      open = true
    }
    for (const run of runs) {
      const text = '[omitted: goal rounds that made no progress (no tool call, or only repeated checks)]'
      agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: OMITTED_SOURCE } }), {
        surfaceOp: { op: 'replace', startSeq: run[0], endSeq: run.at(-1) },
        sourceEventSeqs: nodes.slice(nodes.indexOf(run[0]), nodes.indexOf(run.at(-1)) + 1),
      })
    }
  }

  ctx.effect(() => ctx.commands.register({
    name: 'clean-idle-rounds',
    description: 'Hide goal rounds that made no progress (no tool call, or only repeated checks) from the AI (the log keeps them)',
    handler({ agent }) {
      if (agent.status !== 'idle') return { kind: 'error', text: 'Run this while the session is idle.' }
      const rounds = idleRounds(agent.session.snapshotEvents())
      const visible = new Set(agent.session.surface?.nodes ?? [])
      const seqs = rounds.flatMap(round => round.seqs).filter(seq => visible.has(seq))
      if (seqs.length === 0) return { kind: 'success', text: 'AIから見えている空回りのラウンドはありません。' }
      const shown = rounds.filter(round => round.seqs.some(seq => visible.has(seq)))
      hide(agent, seqs)
      reset(stateFor(agent))
      return { kind: 'success', text: `🚫 AI非表示：進展のなかった goal のラウンド（ツールなし、または同じ確認の繰り返し） ${shown.length}件（turn ${shown[0].turn}〜${shown.at(-1).turn}）を、AIから見えなくしました。画面とログには残っています。` }
    },
  }))

  ctx.on('session/event', (session, event) => {
    const agent = ctx.agents.get(session.id)
    if (agent === undefined || agent.session !== session) return
    const state = stateFor(agent)
    switch (event.type) {
      case 'turn/start':
        state.round = { turn: event.data.turn, goal: false, calls: [], seqs: [] }
        return
      case 'user/message':
        if (!state.round || event.surfaceOp !== 'append') return
        if (event.data.source?.kind === 'goal') { state.round.goal = true; state.round.seqs.push(event.seq) }
        else if (event.data.source?.kind === 'user') state.round.user = true
        return
      case 'assistant/message':
        if (!state.round) return
        state.round.seqs.push(event.seq)
        for (const block of event.data.message?.content ?? []) if (block?.type === 'tool-call') state.round.calls.push(callKey(block))
        return
      case 'turn/end': {
        const round = state.round
        state.round = undefined
        if (!round) return
        if (round.user) { reset(state); return }
        if (!round.goal || event.data.reason?.kind !== 'completed') return
        const idle = isIdleRound(round.calls, state.recent)
        state.recent.push(round.calls)
        if (state.recent.length > REPEAT_WINDOW) state.recent.shift()
        if (!idle) { const recent = state.recent; reset(state); state.recent = recent; return }
        state.idle.push(round)
        if (!state.nudged && state.idle.length >= cfg.nudgeAfterRounds) state.pending = 'nudge'
        else if (state.nudged && state.idle.length >= cfg.nudgeAfterRounds + cfg.blockAfterRounds) state.pending = 'block'
        return
      }
      default:
    }
  })

  ctx.on('goal/changed', ({ agent, change }) => {
    if (['create', 'resume', 'clear'].includes(change?.operation)) reset(stateFor(agent))
  })

  // Log appends and goal changes cannot run inside a session/event dispatch: act at idle.
  ctx.on('agent/status', async ({ agent, status }) => {
    if (status !== 'idle') return
    const state = states.get(agent)
    const action = state?.pending
    if (!action) return
    state.pending = undefined
    // Keep the latest idle round visible so the model still sees where it stands.
    const stale = state.idle.slice(0, -1)
    const seqs = stale.flatMap(round => round.seqs)
    try { hide(agent, seqs) } catch (error) { log(`could not hide idle rounds: ${error instanceof Error ? error.message : String(error)}`) }
    state.idle = state.idle.slice(-1)
    const seen = stale.filter(round => round.turn !== undefined)
    const turns = seen.length === 0 ? '直前のラウンド' : seen.length === 1 ? `turn ${seen[0].turn}` : `turn ${seen[0].turn}〜${seen.at(-1).turn}`
    if (action === 'nudge') {
      state.nudged = true
      // The idle count continues from the rounds already seen.
      state.idle = [...Array.from({ length: cfg.nudgeAfterRounds - 1 }, () => ({ seqs: [] })), ...state.idle]
      await card(agent, `⏸ goal の空回りを検知：${cfg.nudgeAfterRounds}ラウンド続けて、ツールを使わないか同じ確認の繰り返しだけで終わったため、その報告（${turns}）をAIから見えなくし、次のラウンドで具体的な作業か goal の判断（完了・blocked）を促します。`)
      return
    }
    let goal
    try { goal = ctx.goals.get(agent) } catch { goal = undefined }
    const rounds = cfg.nudgeAfterRounds + cfg.blockAfterRounds
    if (goal !== undefined && goal.phase === 'active') {
      try {
        ctx.goals.block(agent, { id: goal.id, revision: goal.revision }, { code: 'no-progress', message: `${rounds} goal rounds in a row ended without any tool call, including ${cfg.blockAfterRounds} after a note asking for a concrete step.` })
      } catch (error) { log(`could not block the goal: ${error instanceof Error ? error.message : String(error)}`) }
    }
    reset(state)
    await card(agent, `⛔ goal を停止：促した後も${cfg.blockAfterRounds}ラウンド続けて作業が進まなかったため、goal を止めました（blocked）。空回りの報告（${turns}）はAIから見えなくしてあります。指示を具体的にして /goal resume で再開できます。`)
  })

  ctx.effect(() => ctx.systemPrompt.context({
    name: 'goal-stall-guard',
    order: 132,
    text: ({ scope }) => (states.get(scope)?.nudged ? renderStallNote(cfg.nudgeAfterRounds) : ''),
  }))

  ctx.on('agent/disposed', ({ agent }) => { states.delete(agent) })
}
