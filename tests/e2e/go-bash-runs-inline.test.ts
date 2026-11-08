import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { launchCli } from '../helpers/cli-daemon.ts'
import { anthropicMessagesServer, type AnthropicMessagesPlan } from '../fixtures/anthropic-messages-server.ts'
import { nestedSandboxAllowed } from './go-module-operation.fixture.ts'

const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

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
  await writeFile(join(project, 'README.md'), '# Inline bash\n')
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
  const messages = async (conversationId: string) => {
    const reply = await request(`/api/conversations/${conversationId}/history`)
    expect(reply.status, JSON.stringify(reply.body)).toBe(200)
    return ((reply.body as { messages?: Message[] }).messages ?? [])
  }
  return { daemon, provider, request, messages }
}

type Service = Awaited<ReturnType<typeof service>>

const assistantText = (messages: Message[]) => messages.filter(m => m.role === 'assistant').map(m => m.text).join('\n')

test.skipIf(!nestedSandboxAllowed())('a bash call runs inside the turn even when the model asks for the background', async () => {
  const { root, project } = await workspace('graph-inline-bash-')
  const gate = join(project, 'release-gate')
  const service_ = await service(root, project, [
    { tool: { id: 'call-a', name: 'bash', input: { command: `while [ ! -f ${gate} ]; do sleep 0.2; done; echo marker-a`, async: true } } },
    { text: '命令已经跑完，我看到了 marker-a。' },
  ])
  const created = await service_.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'local', text: '跑一条命令。', requestId: 'inline-1' }),
  })
  expect(created.status, JSON.stringify(created.body)).toBe(200)
  const conversationId = (created.body as { conversationId: string }).conversationId
  await writeFile(gate, 'go')

  await expect.poll(async () => (await service_.messages(conversationId))
    .filter(message => message.role === 'assistant' && message.text.includes('我看到了 marker-a')).length, {
    timeout: 90_000, interval: 250,
  }).toBe(1)

  const history = await service_.messages(conversationId)
  expect(assistantText(history), '回合里出现了后台回执').not.toContain('已在后台执行')
  const notices = history.filter(message => (message.data as { source?: { kind?: string } } | null)?.source?.kind === 'tool_settled')
  expect(notices.length, '仍然生成了一条后台结算消息').toBe(0)
  const background = await service_.request(`/api/conversations/${conversationId}/tool-calls`)
  expect(background.status, '后台工具调用接口应当已经不存在').toBe(404)
  const toolRows = history.filter(message => message.role === 'tool')
  expect(toolRows.some(row => row.text.includes('marker-a')), '工具输出没有留在这一轮的记录里').toBe(true)
}, 180_000)
