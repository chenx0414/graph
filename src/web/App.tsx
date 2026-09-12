import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { GraphCanvas } from './GraphCanvas.tsx';

type TaskList = { id: string; phase: string }[];
type TaskView = {
  id: string; request: string; phase: string; status: string; proposalVersion: number;
  messages: { text: string }[]; questions: { id: string; kind: string; status: string; data: { prompt?: string; grant?: string } }[];
  nodes: { id: string; status: string; used?: number | null; selectedModel?: string; boundDefinition?: string }[];
  cost: { unknown?: boolean; amount?: number }; proposal: { summary?: string } | null;
};
type Settings = { projects: { id: string; root: string }[]; models: { id: string; grade: string }[]; definitions: { id: string; version: number }[]; capabilities: { id: string; version: string }[] };
type GraphPayload = {
  nodes: { id: string; kind: string; status: string; container?: string; used?: number | null }[];
  containers: { id: string; parent?: string; nodes: string[] }[];
  loops: { from: string; to: string }[];
  revisions: { version: number; reason: string }[];
  layout: { positions: Record<string, { x: number; y: number; width: number; height: number }>; edges: { id: string; source: string; target: string }[] };
  cost: { unknown?: boolean; amount?: number };
};

function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  return hash;
}

export function App() {
  const [path, setPath] = useState(route);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tasks, setTasks] = useState<TaskList>([]);
  useEffect(() => {
    const onHash = () => setPath(route());
    window.addEventListener('hashchange', onHash);
    void api<Settings>('/api/settings').then(setSettings);
    void api<TaskList>('/api/tasks').then(setTasks);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const taskMatch = /^\/tasks\/([^/]+)(\/graph)?$/.exec(path);
  return (
    <div>
      <nav>
        <a href="#/">概览</a>
        <a href="#/catalog">人才库</a>
      </nav>
      {path === '/' && <Overview settings={settings} tasks={tasks} onTasks={setTasks} />}
      {path === '/catalog' && <Catalog settings={settings} />}
      {taskMatch && !taskMatch[2] && <TaskPanel id={taskMatch[1]!} />}
      {taskMatch?.[2] && <GraphPanel id={taskMatch[1]!} />}
    </div>
  );
}

function Overview({ settings, tasks, onTasks }: { settings: Settings | null; tasks: TaskList; onTasks: (tasks: TaskList) => void }) {
  const [request, setRequest] = useState('Add search');
  const [target, setTarget] = useState('main');
  async function begin() {
    const projectId = settings?.projects[0]?.id;
    if (!projectId) return;
    await api('/api/tasks', { method: 'POST', body: JSON.stringify({ projectId, request, requestId: `begin-${Date.now()}` }) });
    onTasks(await api<TaskList>('/api/tasks'));
  }
  return (
    <section>
      <h1>Graph</h1>
      <section data-testid="settings">
        <h2>项目与模型</h2>
        <ul>{settings?.projects.map(project => <li key={project.id}>{project.id} {project.root}</li>)}</ul>
        <ul>{settings?.models.map(model => <li key={model.id}>{model.id} {model.grade}</li>)}</ul>
      </section>
      <section data-testid="queue">
        <h2>任务队列</h2>
        <input value={request} onChange={event => setRequest(event.target.value)} />
        <input value={target} onChange={event => setTarget(event.target.value)} data-testid="target-branch" />
        <button type="button" onClick={() => void begin()}>开始</button>
        <ul>{tasks.map(task => <li key={task.id}><a href={`#/tasks/${task.id}`}>{task.phase}</a> {task.id.slice(0, 8)}</li>)}</ul>
      </section>
    </section>
  );
}

function Catalog({ settings }: { settings: Settings | null }) {
  return (
    <section data-testid="catalog">
      <h2>Agent 库与能力库</h2>
      <ul>{settings?.definitions.map(item => <li key={item.id}>{item.id}@{item.version}</li>)}</ul>
      <ul>{settings?.capabilities.map(item => <li key={item.id}>{item.id}@{item.version}</li>)}</ul>
    </section>
  );
}

function QuestionReply({ taskId, question, onDone }: {
  taskId: string;
  question: { id: string; kind: string; data: { prompt?: string; grant?: string } };
  onDone: () => void;
}) {
  const [tokens, setTokens] = useState('100000');
  const [inputTokens, setInputTokens] = useState('0');
  const [outputTokens, setOutputTokens] = useState('0');
  const [value, setValue] = useState('');
  const [proof, setProof] = useState('');
  const [error, setError] = useState('');
  async function submit(answer: unknown) {
    try {
      await api(`/api/tasks/${taskId}/answer`, { method: 'POST', body: JSON.stringify({ questionId: question.id, answer, requestId: `ans-${question.id}-${crypto.randomUUID()}` }) });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  return (
    <li>
      {question.kind} {question.data.prompt}
      {question.kind === 'budget' && <input data-testid="budget-tokens" type="number" min={1} value={tokens} onChange={event => setTokens(event.target.value)} />}
      {question.kind === 'waiting' && <input data-testid="waiting-value" value={value} onChange={event => setValue(event.target.value)} />}
      {question.kind === 'unknown_usage' && <>
        <input data-testid="usage-input" type="number" min={0} value={inputTokens} onChange={event => setInputTokens(event.target.value)} placeholder="输入 token" />
        <input data-testid="usage-output" type="number" min={0} value={outputTokens} onChange={event => setOutputTokens(event.target.value)} placeholder="输出 token" />
        <input data-testid="usage-proof" value={proof} onChange={event => setProof(event.target.value)} placeholder="证据" />
      </>}
      {question.kind === 'rework' || question.kind === 'stalled' ? <>
        <button type="button" onClick={() => void submit({ type: 'retry' })}>重试</button>
        <button type="button" onClick={() => void submit({ type: 'respond', value })}>答复</button>
      </> : <button type="button" onClick={() => {
        if (question.kind === 'budget') return void submit({ type: 'add_budget', tokens: Number(tokens) });
        if (question.kind === 'waiting') return void submit({ type: 'respond', value });
        if (question.kind === 'unknown_usage') return void submit({ type: 'usage', usage: { input: Number(inputTokens), output: Number(outputTokens), cacheRead: 0, cacheWrite: 0 }, proof });
        if (question.kind === 'permission') return void submit({ type: 'grant', grant: question.data.grant });
        if (['adapter_error', 'execution_failed', 'model_unavailable', 'git_conflict'].includes(question.kind)) return void submit({ type: 'retry' });
        return void submit({ type: 'acknowledge' });
      }}>答复</button>}
      {error && <p data-testid="answer-error">{error}</p>}
    </li>
  );
}

function TaskPanel({ id }: { id: string }) {
  const [view, setView] = useState<TaskView | null>(null);
  const [text, setText] = useState('');
  const [branch, setBranch] = useState('main');
  async function reload() { setView(await api<TaskView>(`/api/tasks/${id}`)); }
  useEffect(() => { void reload(); }, [id]);
  useEffect(() => {
    const stream = new EventSource(`/api/tasks/${id}/events/stream?after=${view?.id ? 0 : 0}`);
    stream.onmessage = () => { void reload(); };
    return () => stream.close();
  }, [id]);
  if (!view) return <p>加载中</p>;
  const open = view.questions.filter(question => question.status === 'open');
  return (
    <section data-testid="task">
      <p data-testid="status">{view.status}</p>
      <p data-testid="cost">{view.cost.unknown ? '未知' : view.cost.amount ?? 0}</p>
      <div data-testid="conversation">{view.messages.map((message, index) => <p key={index}>{message.text}</p>)}</div>
      {view.proposal && <div data-testid="proposal">{view.proposal.summary}</div>}
      <textarea value={text} onChange={event => setText(event.target.value)} />
      <button type="button" onClick={() => void api(`/api/tasks/${id}/say`, { method: 'POST', body: JSON.stringify({ text, requestId: crypto.randomUUID() }) }).then(reload)}>发送</button>
      {view.proposal && <>
        <input value={branch} onChange={event => setBranch(event.target.value)} data-testid="accept-branch" />
        <button type="button" data-testid="accept" onClick={() => void api(`/api/tasks/${id}/accept`, { method: 'POST', body: JSON.stringify({ proposalVersion: view.proposalVersion, targetBranch: branch, requestId: crypto.randomUUID() }) }).then(reload)}>确认需求</button>
      </>}
      <button type="button" data-testid="pause" onClick={() => void api(`/api/tasks/${id}/pause`, { method: 'POST', body: JSON.stringify({ requestId: crypto.randomUUID() }) }).then(reload)}>暂停</button>
      <button type="button" data-testid="resume" onClick={() => void api(`/api/tasks/${id}/resume`, { method: 'POST', body: JSON.stringify({ requestId: crypto.randomUUID() }) }).then(reload)}>继续</button>
      <a href={`#/tasks/${id}/graph`}>任务图</a>
      <ul data-testid="questions">{open.map(question => (
        <QuestionReply key={question.id} taskId={id} question={question} onDone={() => void reload()} />
      ))}</ul>
    </section>
  );
}

function GraphPanel({ id }: { id: string }) {
  const [graph, setGraph] = useState<GraphPayload | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [ops, setOps] = useState<{ nodeId: string; durationMs?: number; result?: { output?: unknown } | null }[]>([]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reload = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void api<GraphPayload>(`/api/tasks/${id}/graph`).then(setGraph);
        void api<typeof ops>(`/api/tasks/${id}/operations?limit=100`).then(setOps);
      }, 150);
    };
    reload();
    const stream = new EventSource(`/api/tasks/${id}/events/stream`);
    stream.onmessage = () => { reload(); };
    return () => { clearTimeout(timer); stream.close(); };
  }, [id]);
  if (!graph) return <p>加载中</p>;
  const selectedNode = graph.nodes.find(node => node.id === selected);
  const selectedOps = ops.filter(item => item.nodeId === selected);
  return (
    <section data-testid="graph" data-editable="false">
      <p data-testid="cost">{graph.cost.unknown ? '未知' : graph.cost.amount ?? 0}</p>
      <p data-testid="revisions">{graph.revisions.map(item => item.reason).join(' / ')}</p>
      {graph.containers.map(container => (
        <button key={container.id} type="button" data-testid={`container-${container.id}`} data-expanded={String(!collapsed[container.id])}
          onClick={() => setCollapsed(current => ({ ...current, [container.id]: !current[container.id] }))}>{container.id}</button>
      ))}
      <GraphCanvas graph={graph} collapsed={collapsed} onSelect={setSelected} />
      {selectedNode && <aside data-testid="node-detail">{selectedNode.id} {selectedNode.status} used={selectedNode.used ?? 0} duration={selectedOps[0]?.durationMs ?? 0}ms {JSON.stringify(selectedOps[0]?.result?.output ?? null)}</aside>}
    </section>
  );
}
