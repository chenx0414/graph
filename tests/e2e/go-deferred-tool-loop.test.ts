import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { launchCli } from '../helpers/cli-daemon.ts'
import { anthropicMessagesServer, type AnthropicMessagesPlan } from '../fixtures/anthropic-messages-server.ts'
import { nestedSandboxAllowed } from './go-module-operation.fixture.ts'

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

test.skipIf(!nestedSandboxAllowed())('A7 后台结果把模型重新拉进同一轮循环：它据此再发起一次工具调用', async () => {
  const { root, project } = await workspace('graph-deferred-loop-')
  const gate = join(project, 'release-gate')
  const service_ = await service(root, project, [
    { tool: { id: 'call-a', name: 'bash', input: { command: `while [ ! -f ${gate} ]; do sleep 0.2; done; echo marker-a`, async: true } } },
    { text: '后台命令已受理。' },
    { text: '第一条结果到达后，我又跑了一次命令。' },
    { tool: { id: 'call-follow', name: 'bash', input: { command: 'echo follow-up-marker' } } },
    { text: '跟进命令也跑完了。' },
  ])
  const created = await service_.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'local', text: '起一条后台命令，结果回来时继续干活。', requestId: 'loop-1' }),
  })
  expect(created.status, JSON.stringify(created.body)).toBe(200)
  const conversationId = (created.body as { conversationId: string }).conversationId

  await expect.poll(async () => (await service_.toolCalls(conversationId))[0]?.state, { timeout: 60_000, interval: 250 }).toBe('running')

  await writeFile(gate, 'go')

  await expect.poll(async () => (await service_.messages(conversationId))
    .filter(message => message.role === 'assistant' && message.text.includes('第一条结果到达后')).length, {
    timeout: 90_000, interval: 250,
  }).toBe(1)

  await expect.poll(async () => (await service_.messages(conversationId))
    .filter(message => message.role === 'tool' && message.text.includes('follow-up-marker')).length, {
    timeout: 90_000, interval: 250,
  }).toBe(1)

  const calls = await service_.toolCalls(conversationId)
  expect(calls.find(call => call.toolCallId === 'call-a')?.result ?? '', '第一条结果里没有命令输出').toContain('marker-a')

  const history = await service_.messages(conversationId)
  expect(assistantText(history).match(/marker-a/g) ?? [], '同一条结果被播报超过一次').toHaveLength(1)
  const resumes = history.filter(message => (message.data as { source?: { kind?: string } } | null)?.source?.kind === 'tool_settled')
  expect(resumes.length, '结算应该拉起一次，实际 ' + String(resumes.length)).toBe(1)
}, 240_000)