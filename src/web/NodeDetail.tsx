import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { NODE_LABEL, when } from './labels.ts';
import { costText, ErrorBox, useTaskStream } from './shared.tsx';
import { Button, Empty, Pill, Spinner, Stat } from './ui.tsx';

interface Entry { seq: number; id: string; role: string; kind: string; text: string; data: Record<string, unknown> | null; operationId: string | null; createdAt: number }
interface Operation { id: string; state: string; runMs: number | null; waitingMs: number; waitingSlot: boolean; result: { output?: unknown } | null; usage: Record<string, number> | null }
interface Invocation { id: string; model: string; purpose?: string; usage: Record<string, number> | null; cost: { unknown?: boolean; amount?: number; currency?: string } | null }
interface Question { id: string; kind: string; status: string }
interface Evidence { acceptanceId: string; valid: boolean; commitSha: string | null }
export interface NodeRun {
  taskId: string; nodeId: string;
  node: { id: string; kind: string; action: string; role: string | null; status: string; definitionVersion?: string; input?: unknown };
  instance: { id: string; model: string | null; definitionVersion: string | null; used: number; budget: number | null; unlimited: boolean; modelsUsed: string[] } | null;
  session: { sessionId: string; sessionFile: string | null } | null;
  operations: Operation[]; invocations: Invocation[]; questions: Question[]; evidence: Evidence[];
  entries: Entry[]; entryCount: number; hasOlder: boolean; hasNewer: boolean; phase: string;
  capabilities?: { id: string; version: string; kind: string | null; state: string; reason: string | null }[];
  capabilityDigest?: string | null;
  timing?: { totalMs: number | null; runMs: number | null; waitingMs: number; pauseMs?: number | null; userWaitMs?: number | null; inProgress?: boolean };
  container?: { id: string; parent: string | null; outputs: string[] } | null;
  children?: { id: string; status: string }[];
}

function formatMs(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '—';
  if (value < 1_000) return `${value}ms`;
  return `${(value / 1_000).toFixed(1)}s`;
}

function usageText(usage: Record<string, number> | null) {
  if (!usage) return '未知';
  const total = Object.values(usage).reduce((sum, value) => sum + (typeof value === 'number' ? value : 0), 0);
  return `${total.toLocaleString('en-US')} tokens`;
}

/** Read-only node detail: real Pi entries, tools, operations and evidence.
 * Never starts an agent, injects a message or triggers a tool. */
export function NodeRunPanel({ taskId, nodeId, onClose, full }: { taskId: string; nodeId: string; onClose?: () => void; full?: boolean }) {
  const [data, setData] = useState<NodeRun | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [olderSeq, setOlderSeq] = useState<number | null>(null);
  const [olderLoading, setOlderLoading] = useState(false);
  const [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const entriesRef = useRef<Entry[]>([]);
  const generationRef = useRef(0);
  // Every task/node pair has its own generation: an in-flight response for a
  // previous entity must never write into the current one.
  const scopeRef = useRef('');
  useEffect(() => { entriesRef.current = entries; }, [entries]);

  const pump = useCallback(async (startAfter: number | undefined, generation: number) => {
    const scope = `${taskId}:${nodeId}`;
    let after = startAfter;
    // Bounded forward paging: a burst larger than one page is drained here,
    // without waiting for another unrelated SSE event.
    for (let page = 0; page < 60; page += 1) {
      const query = after === undefined ? 'limit=200' : `after=${after}&limit=200`;
      const result = await api<NodeRun>(`/api/tasks/${taskId}/nodes/${nodeId}/run?${query}`);
      if (scopeRef.current !== scope || generation !== generationRef.current) return;
      setData(result);
      setEntries(current => {
        const merged = new Map(current.map(entry => [entry.id, entry]));
        for (const entry of result.entries) merged.set(entry.id, entry);
        return [...merged.values()].sort((left, right) => left.seq - right.seq);
      });
      const last = result.entries[result.entries.length - 1]?.seq;
      if (last !== undefined) after = last;
      if (!result.hasNewer) return;
    }
  }, [taskId, nodeId]);

  const refresh = useCallback(() => {
    const generation = generationRef.current;
    const last = entriesRef.current[entriesRef.current.length - 1]?.seq;
    void pump(last, generation).catch(reason => {
      if (scopeRef.current === `${taskId}:${nodeId}`) setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [pump, taskId, nodeId]);

  useEffect(() => {
    scopeRef.current = `${taskId}:${nodeId}`;
    generationRef.current += 1;
    entriesRef.current = [];
    setData(null);
    setEntries([]);
    setOlderSeq(null);
    setError('');
    void pump(undefined, generationRef.current).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [taskId, nodeId, pump]);

  const connected = useTaskStream(taskId, event => {
    if (!event.type.startsWith('node.') && !event.type.startsWith('operation.')) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(refresh, 150);
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  async function loadOlder() {
    const first = entries[0]?.seq;
    if (first === undefined || olderLoading) return;
    setOlderLoading(true);
    try {
      const generation = generationRef.current;
      const page = await api<{ entries: Entry[] }>(`/api/tasks/${taskId}/nodes/${nodeId}/run?before=${first}&limit=100`);
      if (generation !== generationRef.current) return;
      if (!page.entries.length) setOlderSeq(0);
      else {
        setEntries(current => {
          const merged = new Map(current.map(entry => [entry.id, entry]));
          for (const entry of page.entries) merged.set(entry.id, entry);
          return [...merged.values()].sort((left, right) => left.seq - right.seq);
        });
        setOlderSeq(page.entries[0]!.seq);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setOlderLoading(false);
    }
  }

  if (error && !data) return <ErrorBox message={error} onRetry={refresh} />;
  if (!data) return <Spinner />;
  const timing = data.timing ?? { totalMs: null, runMs: null, waitingMs: 0, pauseMs: null, userWaitMs: null, inProgress: false };
  const knownTokens = data.instance
    ? data.instance.used
    : data.invocations.reduce((sum, invocation) => sum + (invocation.usage ? Object.values(invocation.usage).reduce((inner, value) => inner + value, 0) : 0), 0);
  const costAmounts: Record<string, number> = {};
  let unknownCost = false;
  for (const invocation of data.invocations) {
    const cost = invocation.cost as { unknown?: boolean; amount?: number; currency?: string } | null;
    if (!cost || cost.unknown === true || typeof cost.amount !== 'number') { unknownCost = true; continue; }
    const currency = cost.currency ?? '';
    costAmounts[currency] = (costAmounts[currency] ?? 0) + cost.amount;
  }
  const costSummary = { unknown: unknownCost, amounts: costAmounts };
  const summaryCalls = data.invocations.filter(invocation => invocation.purpose === 'compaction').length;
  const hasOlder = data.hasOlder && data.entryCount > entries.length && olderSeq !== 0;

  return (
    <div className="stack" data-testid={`node-run-${nodeId}`} style={{ gap: 12 }}>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <Pill tone={data.node.status === 'succeeded' ? 'success' : data.node.status === 'failed' ? 'danger' : 'info'}>{NODE_LABEL[data.node.status] ?? data.node.status}</Pill>
        <Pill>{data.node.kind === 'program' ? '程序节点' : data.node.role === 'master' ? '主 Agent' : 'Agent 节点'}</Pill>
        <span className="muted">{data.node.action}{data.node.definitionVersion ? ` · ${data.node.definitionVersion}` : ''}{data.instance?.model ? ` · ${data.instance.model}` : ''}</span>
        <span className="muted">{connected ? '实时' : '已断开'}</span>
        {onClose && <Button size="sm" variant="ghost" onClick={onClose}>关闭</Button>}
      </div>

      <div className="stat-grid">
        <Stat label="运行时间" value={timing.runMs == null ? (timing.inProgress ? '进行中' : '未记录') : formatMs(timing.runMs)} hint="实际工作时段之和，HTTP 在途计入" />
        <Stat label="总历时" value={timing.totalMs == null ? (timing.inProgress ? '进行中' : '未记录') : formatMs(timing.totalMs)} hint="首次派发到最后结算，含等待" />
        <Stat label="凭据等待" value={formatMs(timing.waitingMs)} hint="凭据排队，不计入运行时间" />
        <Stat label="暂停" value={timing.pauseMs == null ? '未记录' : formatMs(timing.pauseMs)} hint="任务暂停期间累计，按状态边界写账" />
        <Stat label="等待用户" value={timing.userWaitMs == null ? '未记录' : formatMs(timing.userWaitMs)} hint="问题未答期间累计，按状态边界写账" />
        <Stat label="用量" value={data.instance?.unlimited ? `${knownTokens.toLocaleString('en-US')} · 不限` : knownTokens.toLocaleString('en-US')} hint={data.instance?.budget === null || data.instance?.budget === undefined ? '额度不限' : `预算 ${data.instance.budget.toLocaleString('en-US')}`} />
        <Stat label="费用" value={costText(costSummary)} hint={unknownCost ? '存在未知价格调用，未折零' : '按调用时价格快照，分币种合计'} />
        <Stat label="记录" value={entries.length} hint={`${data.entryCount} 条`} />
      </div>

      {(data.capabilities ?? []).length > 0 && (
        <section>
          <h4 className="section-title">能力（按节点绑定的定义版本）</h4>
          {data.capabilityDigest && <p className="muted mono">bundle {data.capabilityDigest.slice(0, 16)}</p>}
          <ul className="list" data-testid="node-capabilities">
            {data.capabilities!.map(capability => (
              <li key={`${capability.id}@${capability.version}`} className="list-item">
                <span className="grow">{capability.id}@{capability.version}{capability.kind ? ` · ${capability.kind}` : ''}</span>
                <Pill tone={capability.state === '可执行' ? 'success' : capability.state === '禁用' ? 'danger' : 'neutral'}>{`已绑定/${capability.state}`}</Pill>
                {capability.reason && <span className="muted">{capability.reason}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.container && (
        <section>
          <h4 className="section-title">容器 {data.container.id}</h4>
          <p className="muted">父容器：{data.container.parent ?? '无'} · 输出：{data.container.outputs.join(', ') || '无'}</p>
          <ul className="list" data-testid="container-children">
            {(data.children ?? []).map(child => (
              <li key={child.id} className="list-item">
                <a className="grow" href={`#/tasks/${taskId}/nodes/${child.id}`}>{child.id}</a>
                <Pill tone={child.status === 'succeeded' ? 'success' : child.status === 'failed' ? 'danger' : 'info'}>{NODE_LABEL[child.status] ?? child.status}</Pill>
              </li>
            ))}
          </ul>
          {!(data.children ?? []).length && <p className="muted">容器暂无子节点。</p>}
        </section>
      )}

      {!data.container && data.node.kind === 'program' && (
        <section>
          <h4 className="section-title">程序节点</h4>
          {data.node.input !== undefined && <pre data-testid="program-input">{JSON.stringify(data.node.input, null, 2)}</pre>}
          {!data.operations.length && <p className="muted">尚未运行；命令与证据会在执行后出现。</p>}
        </section>
      )}

      <section>
        <h4 className="section-title">对话与工具（真实 Pi 会话）</h4>
        {data.session && <p className="muted">会话 <code>{data.session.sessionId}</code></p>}
        {!entries.length && <Empty title="暂无记录" hint="该节点还没有产生 Pi 会话条目，或记录不可得。" />}
        <ol className="list" data-testid="node-entries">
          {entries.map(entry => (
            <li key={entry.id} className="list-item" style={{ display: 'block', alignItems: 'flex-start' }} data-testid={`node-entry-${entry.role}`} data-kind={entry.kind}>
              <div className="row">
                <Pill tone={entry.kind === 'compaction' ? 'warn' : entry.role === 'assistant' ? 'info' : entry.role === 'tool' ? 'neutral' : 'accent'}>{entry.kind === 'compaction' ? '上下文摘要' : entry.role === 'user' ? '任务说明' : entry.role === 'assistant' ? '主/工人回复' : entry.role === 'tool' ? `工具${entry.kind === 'call' ? '调用' : '结果'}` : entry.role}</Pill>
                {entry.kind === 'compaction' && <span className="muted" data-testid="entry-compaction">窗口写满后的自动摘要，原始记录仍保留</span>}
                <span className="muted">{when(entry.createdAt)}</span>
              </div>
              {entry.text.length > 4_000
                ? <details data-testid="entry-full"><summary className="muted">查看完整内容（共 {entry.text.length.toLocaleString('en-US')} 字）</summary><pre style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{entry.text}</pre></details>
                : <pre style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{entry.text}</pre>}
              {entry.text.length > 4_000 && <pre className="faint" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{entry.text.slice(0, 4_000)}…</pre>}
            </li>
          ))}
        </ol>
        {hasOlder && <Button size="sm" data-testid="node-entries-more" disabled={olderLoading} onClick={() => void loadOlder()}>{olderLoading ? '载入中…' : '载入更早记录'}</Button>}
      </section>

      <section>
        <h4 className="section-title">运行记录（{data.operations.length} 次尝试）</h4>
        <ol className="list" data-testid="node-operations">
          {data.operations.map(operation => (
            <li key={operation.id} className="list-item" style={{ display: 'block' }}>
              <div className="row">
                <Pill tone={operation.state === 'succeeded' ? 'success' : operation.state === 'interrupted' || operation.state === 'unknown' ? 'warn' : 'info'}>{operation.state}</Pill>
                <span className="muted">运行 {formatMs(operation.runMs)}{operation.waitingMs ? ` · 等待名额 ${formatMs(operation.waitingMs)}` : ''} · 用量 {usageText(operation.usage)}</span>
              </div>
              {operation.result?.output !== undefined && <pre style={{ marginTop: 6 }}>{JSON.stringify(operation.result.output, null, 2).slice(0, 2_000)}</pre>}
            </li>
          ))}
        </ol>
      </section>

      <section>
        <h4 className="section-title">供应商调用（{data.invocations.length}{summaryCalls ? `，含 ${summaryCalls} 次摘要调用` : ''}）</h4>
        <ul className="list" data-testid="node-invocations">
          {data.invocations.map(invocation => (
            <li key={invocation.id} className="list-item">
              <span className="grow">{invocation.model} · {usageText(invocation.usage)}{invocation.purpose === 'compaction' ? ' · 上下文摘要' : ''}</span>
              <span className="muted">{invocation.cost === null || invocation.cost.unknown ? '费用未知' : `${invocation.cost.amount?.toFixed(6) ?? '?'} ${invocation.cost.currency ?? ''}`}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h4 className="section-title">问题与验收</h4>
        {data.questions.filter(question => question.status === 'open').map(question => (
          <p key={question.id}><Pill tone="warn">{question.kind}</Pill> 等待处理（在任务页答复）</p>
        ))}
        {data.evidence.length ? data.evidence.map(item => (
          <p key={item.acceptanceId} data-testid={`node-evidence-${item.acceptanceId}`}>{item.acceptanceId}:{item.valid ? '有效' : '无效或过期'}{item.commitSha ? ` · ${item.commitSha.slice(0, 10)}` : ''}</p>
        )) : <p className="muted">尚无验收证据。</p>}
      </section>
      {error && <ErrorBox message={error} onRetry={refresh} />}
      {full && <p className="muted">本页只读：不会启动新 Agent、插话或触发工具。继续沟通请回到对话页。</p>}
    </div>
  );
}
