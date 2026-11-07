import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { launchCli } from '../helpers/cli-daemon.ts'
import { anthropicMessagesServer, type AnthropicMessagesPlan } from '../fixtures/anthropic-messages-server.ts'

const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

interface ToolCall {
  toolCallId: string
  name: string
  state: string
  result?: string
  reason?: string
}

interface Message {
  id: string
  seq: number
  role: string
  kind: string
  text: string
  data: Record<string, unknown> | null
}

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.reverse()) await close()
  cleanup.length = 0
})

async function workspace(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(project, { recursive: true })
  await writeFile(join(project, 'README.md'), '# Deferred tool loop\n')
  git(project, ['init', '-q', '-b', 'main'])
  git(project, ['config', 'user.email', 'graph@example.invalid'])
  git(project, ['config', 'user.name', 'Graph Test'])
  git(project, ['add', '.'])
  git(project, ['commit', '-q', '-m', 'initial'])
  await mkdir(join(root, 'web'), { recursive: true })
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>')
  return { root, project }
}

async function service(root: string, project: string, plans: AnthropicMessagesPlan[]) {
  const provider = await anthropicMessagesServer(plans)
  cleanup.push(() => provider.close())
  const configPath = join(root, 'graph.config.json')
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_DEFERRED_LOOP_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-anthropic', api: 'anthropic-messages', baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 512, credentialId: 'local' }] },
  }))
  const daemon = await launchCli(root, { configPath, env: { GRAPH_DEFERRED_LOOP_KEY: 'synthetic-deferred-loop-key' }, extraArgs: ['--execute'] })
  cleanup.push(() => daemon.close())
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, init)
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown }
  }
  const toolCalls = async (conversationId: string) => {
    const reply = await request(`/api/conversations/${conversationId}/tool-calls`)
    expect(reply.status, JSON.stringify(reply.body)).toBe(200)
    return ((reply.body as { toolCalls?: ToolCall[] }).toolCalls ?? [])
  }
  const messages = async (conversationId: string) => {
    const reply = await request(`/api/conversations/${conversationId}/history`)
    expect(reply.status, JSON.stringify(reply.body)).toBe(200)
    return ((reply.body as { messages?: Message[] }).messages ?? [])
  }
  return { daemon, provider, request, toolCalls, messages }
}

type Service = Awaited<ReturnType<typeof service>>

const assistantText = (messages: Message[]) => messages.filter(m => m.role === 'assistant').map(m => m.text).join('\n')

test('A7 后台结果把模型重新拉进同一轮循环：它据此再发起一次工具调用，两条结果各自只回一次', async () => {
  const { root, project } = await workspace('graph-deferred-loop-')
  const gateA = join(project, 'release-a')
  const gateB = join(project, 'release-b')
  const service_ = await service(root, project, [
    { tool: { id: 'call-a', name: 'bash', input: { command: `while [ ! -f ${gateA} ]; do sleep 0.2; done; echo marker-a`, async: true } } },
    { tool: { id: 'call-b', name: 'bash', input: { command: `while [ ! -f ${gateB} ]; do sleep 0.2; done; echo marker-b`, async: true } } },
    { text: '两条后台命令都已受理。' },
    { tool: { id: 'call-follow', name: 'bash', input: { command: 'echo follow-up-marker' } } },
    { text: '第一条结果到达后，我又跑了一次命令。' },
    { text: '第二条结果也到了。' },
  ])
  const created = await service_.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'local', text: '并行起两条后台命令，结果回来时继续干活。', requestId: 'loop-1' }),
  })
  expect(created.status, JSON.stringify(created.body)).toBe(200)
  const conversationId = (created.body as { conversationId: string }).conversationId

  await expect.poll(async () => (await service_.toolCalls(conversationId)).length, { timeout: 90_000, interval: 250 }).toBe(2)
  const before = service_.provider.requests.length
  expect(before, `受理两条后台调用只用了 ${before} 次 provider 请求`).toBeGreaterThanOrEqual(3)

  await writeFile(gateA, 'go')
  await expect.poll(() => service_.provider.requests.length, { timeout: 90_000, interval: 250 }).toBeGreaterThan(before)

  await expect.poll(async () => {
    const calls = await service_.toolCalls(conversationId)
    return calls.find(call => call.toolCallId === 'call-follow')?.state
  }, { timeout: 90_000, interval: 250 }).toBe('settled')

  const calls = await service_.toolCalls(conversationId)
  const a = calls.find(call => call.toolCallId === 'call-a')
  const b = calls.find(call => call.toolCallId === 'call-b')
  const follow = calls.find(call => call.toolCallId === 'call-follow')
  expect(a?.state, '第一条后台调用没有结算').toBe('settled')
  expect(a?.result ?? '', '第一条结果里没有命令输出').toContain('marker-a')
  expect(b?.state, '第二条后台调用不该因为第一条的结果而结束').toBe('running')
  expect(follow?.result ?? '', '跟进的那次调用没有真的跑起来').toContain('follow-up-marker')

  await writeFile(gateB, 'go')
  await expect.poll(async () => (await service_.toolCalls(conversationId)).find(call => call.toolCallId === 'call-b')?.state, {
    timeout: 90_000, interval: 250,
  }).toBe('settled')

  const history = await service_.messages(conversationId)
  const said = assistantText(history)
  expect(said, '模型没有在一次结果到达后被重新拉起').toContain('第一条结果到达后')
  expect(said, '模型的第二轮没有跑跟进命令').toContain('我又跑了一次命令')
  expect(said, '第二条结果到达后模型没有被再次拉起').toContain('第二条结果也到了')
  expect(said.match(/marker-a/g) ?? [], '同一条结果被播报超过一次').toHaveLength(1)
}, 240_000)
