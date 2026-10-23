// Goal rounds that make no progress: a round that ends without a single tool
// call only restates status. After a few such rounds in a row the next round
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
const CARD_COMMAND = 'goal-stall'

/** The note added to the runtime context of the rounds after a stall was noticed. */
export function renderStallNote(rounds) {
  return [
    '<goal-progress>',
    `The last ${rounds} goal rounds ended without any tool call: each only restated the current status. Those rounds are hidden from the history.`,
    'In this round, either take the next concrete step toward the objective with tools (name it, then do it), or settle the goal: mark it complete with update_goal if the objective is met, or mark it blocked with the specific reason it cannot advance.',
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
      state = { round: undefined, idle: [], nudged: false, pending: undefined }
      states.set(agent, state)
    }
    return state
  }
  const reset = (state) => { state.idle = []; state.nudged = false; state.pending = undefined }

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
      const text = '[omitted: goal rounds that ended with a status report and no tool call]'
      agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: OMITTED_SOURCE } }), {
        surfaceOp: { op: 'replace', startSeq: run[0], endSeq: run.at(-1) },
        sourceEventSeqs: nodes.slice(nodes.indexOf(run[0]), nodes.indexOf(run.at(-1)) + 1),
      })
    }
  }

  ctx.on('session/event', (session, event) => {
    const agent = ctx.agents.get(session.id)
    if (agent === undefined || agent.session !== session) return
    const state = stateFor(agent)
    switch (event.type) {
      case 'turn/start':
        state.round = { turn: event.data.turn, goal: false, toolCalls: 0, seqs: [] }
        return
      case 'user/message':
        if (!state.round || event.surfaceOp !== 'append') return
        if (event.data.source?.kind === 'goal') { state.round.goal = true; state.round.seqs.push(event.seq) }
        else if (event.data.source?.kind === 'user') state.round.user = true
        return
      case 'assistant/message':
        if (!state.round) return
        state.round.seqs.push(event.seq)
        if (event.data.message?.content?.some(block => block?.type === 'tool-call')) state.round.toolCalls++
        return
      case 'turn/end': {
        const round = state.round
        state.round = undefined
        if (!round) return
        if (round.user || !round.goal || round.toolCalls > 0) { if (round.toolCalls > 0 || round.user) reset(state); return }
        if (event.data.reason?.kind !== 'completed') return
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
      await card(agent, `⏸ goal の空回りを検知：${cfg.nudgeAfterRounds}ラウンド続けてツールを使わず状況報告だけで終わったため、その報告（${turns}）をAIから見えなくし、次のラウンドで具体的な作業か goal の判断（完了・blocked）を促します。`)
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
