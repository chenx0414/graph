import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import { Button, Card, Field, Pill, Spinner, toast } from './ui.tsx';

type Cost = { input: number; output: number; cacheRead: number; cacheWrite: number };
type RawModel = {
  id: string; provider: string; grade: string; api: 'openai-completions'; baseUrl: string;
  contextWindow: number; maxTokens: number; credentialId: string; cost?: Cost;
  headers?: Record<string, string>;
};
type RawCredential = { secretRef: string; displayName?: string; sharedLimitGroupId?: string };
type RawConfig = {
  version: 1;
  projects?: { id: string; root: string; grants?: string[] }[];
  models?: { entries: RawModel[]; preferences?: Record<string, string[]> };
  credentials?: Record<string, RawCredential>;
  limits?: { credentials?: Record<string, number>; sharedGroups?: Record<string, number> };
};
type ConfigResponse = { revision: number; config: RawConfig & { path: string | null; credentials?: Record<string, RawCredential & { configured?: boolean }> } };
type TestResult = { ok: boolean; model?: string; credentialId?: string; status?: number; latencyMs?: number; message?: string };
type Startup = { effectiveRevision?: number };
type ApiError = Error & { code?: string; field?: string };

const GRADES = ['low', 'medium', 'high', 'highest'];

function emptyModel(): RawModel {
  return { id: 'new-model', provider: 'local', grade: 'medium', api: 'openai-completions', baseUrl: 'http://127.0.0.1:8080/v1', contextWindow: 32768, maxTokens: 4096, credentialId: '' };
}

/** Strip server-side display flags so the draft can be saved back verbatim. */
function toDraft(config: ConfigResponse['config']): RawConfig {
  const credentials: Record<string, RawCredential> = {};
  for (const [id, credential] of Object.entries(config.credentials ?? {})) {
    const { configured: _configured, ...rest } = credential;
    credentials[id] = rest;
  }
  return {
    version: 1,
    projects: config.projects ?? [],
    ...(config.models ? { models: { entries: config.models.entries, ...(config.models.preferences ? { preferences: config.models.preferences } : {}) } } : {}),
    credentials,
    limits: config.limits ?? {},
  };
}

type Preparation = { state: string; repoRoot: string | null; projectSubdir: string | null; baselineSha: string | null; detail: { dirty?: number; reason?: string } | null };
type ProjectRow = { id: string; root: string; preparation: Preparation | null };

/** Git admission entry: ordinary directories are initialized by the host and a
 * dirty repository needs an explicit local baseline before formal dispatch. */
function ProjectGitCard() {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    const data = await api<{ projects: ProjectRow[] }>('/api/settings');
    setProjects(data.projects.filter(project => !project.id.startsWith('conversation:')));
  }, []);
  useEffect(() => { void load().catch(() => undefined); }, [load]);
  const prepare = async (project: ProjectRow, createBaseline: boolean) => {
    setBusy(project.id);
    try {
      const result = await api<{ state: string }>(`/api/projects/${encodeURIComponent(project.id)}/prepare`, {
        method: 'POST',
        body: JSON.stringify({ requestId: `prepare-${project.id}-${crypto.randomUUID()}`, initialize: true, createBaseline }),
      });
      toast(result.state === 'ready' ? 'Git 准备完成' : '需要处理未提交修改', result.state === 'ready' ? 'success' : 'info');
    } catch (reason) {
      toast(`准备失败：${reason instanceof Error ? reason.message : String(reason)}`, 'danger');
    } finally {
      setBusy('');
      await load().catch(() => undefined);
    }
  };
  const label = (state: string | undefined) => state === 'ready' ? '已准备' : state === 'detected' ? '待处理' : state === 'failed' ? '失败' : '未准备';
  return (
    <Card title="项目 Git 准备" icon="box" subtitle="正式派发前必须准备好 Git 与本地基线；普通目录由宿主初始化并建立本地版本记录">
      {projects === null && <Spinner />}
      {projects?.length === 0 && <p className="muted">尚未配置项目。</p>}
      {projects?.map(project => {
        const prep = project.preparation;
        const dirty = prep?.detail?.dirty ?? 0;
        return (
          <div className="list-item" key={project.id} data-testid={`git-project-${project.id}`}>
            <div className="row grow" style={{ alignItems: 'center' }}>
              <Pill tone={prep?.state === 'ready' ? 'success' : prep?.state === 'failed' ? 'danger' : prep?.state === 'detected' ? 'warn' : 'neutral'}>{label(prep?.state)}</Pill>
              <span className="grow">{project.id} <span className="muted">{project.root}</span></span>
              {prep?.projectSubdir && <span className="muted">子目录 {prep.projectSubdir}</span>}
              {prep?.baselineSha && <code className="faint">{prep.baselineSha.slice(0, 10)}</code>}
            </div>
            {prep?.state === 'detected' && <span className="muted">{dirty ? `${dirty} 项未提交修改；创建基线将把这些改动纳入本地快照` : prep.detail?.reason === 'not_a_repository' ? '尚未初始化 Git' : '需要准备'}</span>}
            {prep?.state === 'failed' && <span className="muted">{prep.detail?.reason ?? '准备失败'}</span>}
            <Button size="sm" data-testid={`git-prepare-${project.id}`} disabled={busy === project.id} onClick={() => void prepare(project, prep?.state === 'detected' && dirty > 0)}>
              {prep?.state === 'detected' && dirty > 0 ? '创建本地基线提交' : '准备 Git'}
            </Button>
          </div>
        );
      })}
    </Card>
  );
}

export function Settings() {
  const [draft, setDraft] = useState<RawConfig | null>(null);
  const [credentialState, setCredentialState] = useState<Record<string, boolean>>({});
  const [revision, setRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [priceStatus, setPriceStatus] = useState('');
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const [effectiveRevision, setEffectiveRevision] = useState<number | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const bridge = typeof window !== 'undefined' ? window.graph : undefined;

  const load = useCallback(async () => {
    try {
      const response = await api<ConfigResponse>('/api/config');
      setDraft(toDraft(response.config));
      setCredentialState(Object.fromEntries(Object.entries(response.config.credentials ?? {}).map(([id, credential]) => [id, Boolean(credential.configured)])));
      setRevision(response.revision);
      setDirty(false);
      setError(null);
      setStatus('');
    } catch (reason) {
      setError(reason as ApiError);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void api<Startup>('/api/startup').then(startup => setEffectiveRevision(startup.effectiveRevision ?? null)).catch(() => undefined); }, []);

  if (!draft) return <Card testid="settings-page"><p data-testid="settings-loading"><Spinner label="加载配置中…" /></p>{error && <p data-testid="config-error" style={{ color: 'var(--danger)' }}>{error.message}</p>}</Card>;

  const mutate = (change: (next: RawConfig) => void) => {
    setDraft(current => {
      const next = structuredClone(current!) as RawConfig;
      change(next);
      return next;
    });
    setDirty(true);
    setStatus('');
  };
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await api<{ revision: number; effectiveRevision?: number; restartRequired: boolean; applied?: boolean; reason?: string; configured?: boolean }>('/api/config', {
        method: 'POST',
        body: JSON.stringify({ expectedRevision: revision, document: { ...draft, version: 1 } }),
      });
      setRevision(response.revision);
      setEffectiveRevision(response.effectiveRevision ?? response.revision);
      setDirty(false);
      setStatus(`已保存 revision ${response.revision}`);
      toast(`配置已保存${response.applied === false ? '，等待生效' : '并已应用'}`, 'success');
      await load();
      const pending = response.applied === false;
      setStatus(`已保存 revision ${response.revision}${pending ? `，等待生效：${response.reason ?? '需要重启守护进程'}` : '，已应用到当前守护进程'}${response.configured === false ? '（尚未配置可用凭据，仅查看模式）' : ''}`);
    } catch (reason) {
      setError(reason as ApiError);
      toast(`保存失败：${(reason as Error).message}`, 'danger');
    } finally {
      setSaving(false);
    }
  };
  const refreshPrices = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const response = await api<{ revision: number; applied: boolean; reason?: string; results?: { modelId: string; status: string; reason?: string }[] }>('/api/pricing/refresh', {
        method: 'POST',
        body: JSON.stringify({ expectedRevision: revision }),
      });
      const known = response.results?.filter(result => result.status === 'known').length ?? 0;
      const stale = response.results?.filter(result => result.status === 'stale').length ?? 0;
      const unknown = response.results?.filter(result => result.status === 'unknown').length ?? 0;
      const manual = response.results?.filter(result => result.status === 'manual').length ?? 0;
      setPriceStatus(`价格快照已刷新 revision ${response.revision}：已核对 ${known}，过期保留旧值 ${stale}，未知 ${unknown}${manual ? `，手动覆盖 ${manual}` : ''}${response.applied === false ? `（未生效：${response.reason ?? '被拒绝'}）` : ''}`);
      toast(response.applied === false ? '价格刷新未生效' : '价格快照已刷新', response.applied === false ? 'danger' : 'success');
      await load();
    } catch (reason) {
      setError(reason as ApiError);
      toast(`价格刷新失败：${(reason as Error).message}`, 'danger');
    } finally {
      setRefreshing(false);
    }
  };
  const testConnection = async (model: RawModel) => {
    setResults(current => ({ ...current, [model.id]: { ok: false, message: '测试中…' } as TestResult }));
    try {
      const result = await api<TestResult>('/api/config/test', { method: 'POST', body: JSON.stringify({ modelId: model.id }) });
      setResults(current => ({ ...current, [model.id]: result }));
      toast(result.ok ? '连接成功' : `连接失败：${result.message ?? '未知原因'}`, result.ok ? 'success' : 'danger');
    } catch (reason) {
      setResults(current => ({ ...current, [model.id]: { ok: false, message: (reason as Error).message } }));
      toast(`连接失败：${(reason as Error).message}`, 'danger');
    }
  };

  const projects = draft.projects ?? [];
  const models = draft.models?.entries ?? [];
  const credentials = Object.entries(draft.credentials ?? {});
  const credentialIds = credentials.map(([id]) => id);
  const invalid = (field: string) => error?.field === field ? 'true' : undefined;

  return (
    <div className="stagger" data-testid="settings-page">
      <Card title="设置" icon="settings" subtitle="保存并应用；价格快照仅在你点击刷新时更新"
        actions={<>
          <Button data-testid="pricing-refresh" icon="refresh" disabled={refreshing || dirty} onClick={() => void refreshPrices()}>{refreshing ? '刷新中…' : '刷新价格快照'}</Button>
          <Button data-testid="settings-reload" icon="refresh" onClick={() => void load()}>重新加载</Button>
          <Button variant="primary" data-testid="settings-save" icon="check" disabled={saving || !dirty} onClick={() => void save()}>{saving ? '保存中…' : '保存配置'}</Button>
        </>}>
        <div className="chip-row">
          <Pill>已保存 revision <span data-testid="config-revision">{revision}</span></Pill>
          {effectiveRevision !== null && <Pill tone="info">当前运行版本 <span data-testid="effective-revision">{effectiveRevision}</span>{effectiveRevision !== revision ? '（有未生效修改）' : ''}</Pill>}
          {dirty && <Pill tone="warn">有未保存修改</Pill>}
        </div>
        {error && <p data-testid="config-error" style={{ color: 'var(--danger)', marginTop: 10 }}>{error.message}{error.code ? `（${error.code}）` : ''}</p>}
        {status && <p data-testid="config-status" className="muted" style={{ marginTop: 10 }}>{status}</p>}
        {priceStatus && <p data-testid="pricing-status" className="muted" style={{ marginTop: 10 }}>{priceStatus}</p>}
        {status.includes('等待生效') && <div data-testid="restart-required" className="hint-card">待生效：当前守护进程仍使用上一份有效绑定；修正配置后可再次保存。</div>}
      </Card>

      <Card title="项目" icon="box" actions={<Button size="sm" icon="plus" data-testid="project-add" onClick={() => mutate(next => { next.projects = [...(next.projects ?? []), { id: 'new-project', root: '.' }]; })}>添加项目</Button>}>
        {!projects.length && <p className="muted">尚未配置项目。</p>}
        {projects.map((project, index) => (
          <div className="list-item" key={index} data-testid={`project-row-${index}`} data-row={index}>
            <div className="row grow">
              <Field label="项目 ID">
                <input className="input" style={{ width: 180 }} data-invalid={invalid(`projects[${index}].id`)} data-testid={`project-${index}-id`} value={project.id} onChange={event => mutate(next => { next.projects![index]!.id = event.target.value; })} />
              </Field>
              <Field label="根目录">
                <input className="input" style={{ width: 380, maxWidth: 'none' }} data-invalid={invalid(`projects[${index}].root`)} data-testid={`project-${index}-root`} value={project.root} onChange={event => mutate(next => { next.projects![index]!.root = event.target.value; })} />
              </Field>
            </div>
            <Button size="sm" variant="danger" onClick={() => mutate(next => { next.projects!.splice(index, 1); })}>删除</Button>
          </div>
        ))}
      </Card>

      <ProjectGitCard />

      <Card title="凭据引用" icon="link" subtitle="只保存环境变量名；密钥从不进入配置文件、接口响应或页面"
        actions={<Button size="sm" icon="plus" data-testid="credential-add" onClick={() => mutate(next => { next.credentials = { ...(next.credentials ?? {}), 'new-credential': { secretRef: 'GRAPH_NEW_KEY' } }; })}>添加凭据</Button>}>
        {!credentials.length && <p className="muted">尚未配置凭据。</p>}
        {credentials.map(([id, credential], index) => (
          <div className="list-item" key={id} data-testid={`credential-row-${index}`} data-id={id}>
            <Field label="ID"><input className="input" style={{ width: 150 }} data-testid={`credential-${index}-id`} value={id} onChange={event => mutate(next => {
              const record = next.credentials!;
              const value = record[id]!;
              delete record[id];
              record[event.target.value] = value;
            })} /></Field>
            <Field label="环境变量"><input className="input" style={{ width: 220 }} data-testid={`credential-${index}-secretRef`} value={credential.secretRef} onChange={event => mutate(next => { next.credentials![id]!.secretRef = event.target.value; })} /></Field>
            <Field label="共享组"><input className="input" style={{ width: 140 }} data-testid={`credential-${index}-group`} value={credential.sharedLimitGroupId ?? ''} placeholder="可选" onChange={event => mutate(next => {
              const value = next.credentials![id]!;
              if (event.target.value) value.sharedLimitGroupId = event.target.value;
              else delete value.sharedLimitGroupId;
            })} /></Field>
            <Pill tone={credentialState[id] ? 'success' : 'warn'} testid={`credential-${index}-state`}>{credentialState[id] ? '已配置' : '缺失'}</Pill>
            {bridge && <>
              <input className="input" style={{ width: 180 }} type="password" placeholder="API 密钥" data-testid={`credential-${index}-key`}
                value={keys[id] ?? ''} onChange={event => setKeys(current => ({ ...current, [id]: event.target.value }))} />
              <Button size="sm" variant="danger" data-testid={`credential-${index}-disable`} title="撤销推送的密钥并禁止该连接新发送"
                onClick={async () => {
                  try {
                    const result = await bridge.saveSecret(credential.secretRef, null);
                    // Revocation persistence lives in the daemon state, so the
                    // applied flag is the proof that the gate changed.
                    if (!result?.applied) throw new Error(result?.message ?? '撤销未生效');
                    setCredentialState(current => ({ ...current, [id]: false }));
                    setKeys(current => ({ ...current, [id]: '' }));
                    toast('连接已禁用；重新保存密钥即可恢复', 'success');
                  } catch (reason) {
                    toast(`禁用失败：${(reason as Error).message}`, 'danger');
                  }
                }}>禁用连接</Button>
              <Button size="sm" icon="link" data-testid={`credential-${index}-key-save`} disabled={!(keys[id] ?? '').trim()}
                onClick={() => void (async () => {
                  const stored = await bridge.saveSecret(credential.secretRef, (keys[id] ?? '').trim());
                  if (stored.stored) {
                    setCredentialState(current => ({ ...current, [id]: true }));
                    setKeys(current => ({ ...current, [id]: '' }));
                    toast('密钥已写入系统钥匙串', 'success');
                  } else {
                    toast(`密钥保存失败：${stored.message ?? '钥匙串不可用'}`, 'danger');
                  }
                })()}>保存到钥匙串</Button>
            </>}
            <Button size="sm" variant="danger" onClick={() => mutate(next => { delete next.credentials![id]; })}>删除</Button>
          </div>
        ))}
      </Card>

      <Card title="模型" icon="bolt" subtitle="连通性测试使用运行版本（effective revision），不读取未生效内容"
        actions={<Button size="sm" icon="plus" data-testid="model-add" onClick={() => mutate(next => { next.models = { entries: [...(next.models?.entries ?? []), { ...emptyModel(), credentialId: credentialIds[0] ?? '' }] }; })}>添加模型</Button>}>
        <p data-testid="test-connection-note" className="faint">连通性测试使用当前运行版本的绑定（effective revision），不读取未生效的保存内容。</p>
        {!models.length && <p className="muted">尚未配置模型。</p>}
        {models.map((model, index) => (
          <div className="card" style={{ margin: '10px 0' }} key={index} data-testid={`model-row-${index}`}>
            <div className="card-body">
              <div className="row">
                <Field label="ID"><input className="input" style={{ width: 150 }} data-invalid={invalid(`models.entries[${index}].id`)} data-testid={`model-${index}-id`} value={model.id} onChange={event => mutate(next => { next.models!.entries[index]!.id = event.target.value; })} /></Field>
                <Field label="Provider"><input className="input" style={{ width: 130 }} data-testid={`model-${index}-provider`} value={model.provider} onChange={event => mutate(next => { next.models!.entries[index]!.provider = event.target.value; })} /></Field>
                <Field label="等级">
                  <select className="select" style={{ width: 110 }} data-testid={`model-${index}-grade`} value={model.grade} onChange={event => mutate(next => { next.models!.entries[index]!.grade = event.target.value; })}>
                    {GRADES.map(grade => <option key={grade} value={grade}>{grade}</option>)}
                  </select>
                </Field>
                <Field label="凭据">
                  <select className="select" style={{ width: 170 }} data-invalid={invalid(`models.entries[${index}].credentialId`)} data-testid={`model-${index}-credentialId`} value={model.credentialId} onChange={event => mutate(next => { next.models!.entries[index]!.credentialId = event.target.value; })}>
                    {!credentialIds.includes(model.credentialId) && <option value={model.credentialId}>{model.credentialId || '（未选择）'}</option>}
                    {credentialIds.map(id => <option key={id} value={id}>{id}（{credentialState[id] ? '已配置' : '缺失'}）</option>)}
                  </select>
                </Field>
                <Pill tone={model.cost ? 'info' : 'warn'} testid={`model-${index}-price`}>{model.cost ? `价格 输入 ${model.cost.input}/输出 ${model.cost.output} 每百万` : '价格未知（未配置，不会按 0 计算）'}</Pill>
                {model.headers && Object.keys(model.headers).length > 0 && (
                  <span className="faint" data-testid={`model-${index}-headers`}>请求头 {Object.entries(model.headers).map(([name, value]) => `${name}=${value}`).join(' · ')}</span>
                )}
              </div>
              <div className="row">
                <Field label="Base URL"><input className="input" style={{ width: 340, maxWidth: 'none' }} data-invalid={invalid(`models.entries[${index}].baseUrl`)} data-testid={`model-${index}-baseUrl`} value={model.baseUrl} onChange={event => mutate(next => { next.models!.entries[index]!.baseUrl = event.target.value; })} /></Field>
                <Field label="上下文"><input className="input" style={{ width: 110 }} type="number" data-testid={`model-${index}-context`} value={model.contextWindow} onChange={event => mutate(next => { next.models!.entries[index]!.contextWindow = Number(event.target.value); })} /></Field>
                <Field label="最大输出"><input className="input" style={{ width: 110 }} type="number" data-testid={`model-${index}-maxTokens`} value={model.maxTokens} onChange={event => mutate(next => { next.models!.entries[index]!.maxTokens = Number(event.target.value); })} /></Field>
                <Field label="输入价/百万"><input className="input" style={{ width: 110 }} type="number" placeholder="未知" data-testid={`model-${index}-input-cost`} value={model.cost?.input ?? ''} onChange={event => mutate(next => {
                  const entry = next.models!.entries[index]!;
                  const value = Number(event.target.value);
                  if (event.target.value === '' || !Number.isFinite(value)) { delete entry.cost; return; }
                  entry.cost = { input: value, output: entry.cost?.output ?? 0, cacheRead: entry.cost?.cacheRead ?? 0, cacheWrite: entry.cost?.cacheWrite ?? 0 };
                })} /></Field>
                <Field label="输出价/百万"><input className="input" style={{ width: 110 }} type="number" placeholder="未知" data-testid={`model-${index}-output-cost`} value={model.cost?.output ?? ''} onChange={event => mutate(next => {
                  const entry = next.models!.entries[index]!;
                  const value = Number(event.target.value);
                  if (event.target.value === '' || !Number.isFinite(value)) { delete entry.cost; return; }
                  entry.cost = { input: entry.cost?.input ?? 0, output: value, cacheRead: entry.cost?.cacheRead ?? 0, cacheWrite: entry.cost?.cacheWrite ?? 0 };
                })} /></Field>
                <Field label="币种"><input className="input" style={{ width: 90 }} placeholder="USD" data-testid={`model-${index}-cost-currency`} value={(model as { pricing?: { currency?: string } }).pricing?.currency ?? ''} onChange={event => mutate(next => {
                  const entry = next.models!.entries[index]! as { pricing?: { currency?: string } };
                  const currency = event.target.value.trim().toUpperCase();
                  if (!currency) { delete entry.pricing; return; }
                  // Manual override freezes its own provenance so historical
                  // calls keep the price snapshot they were estimated with.
                  entry.pricing = { currency, unit: 'per_million_tokens', status: 'known', sourceUrl: 'manual' } as never;
                })} /></Field>
              </div>
              <div className="row">
                <Button size="sm" icon="bolt" data-testid={`model-${index}-test`} onClick={() => void testConnection(model)}>测试连接（可能产生用量）</Button>
                {results[model.id] && <span data-testid={`connection-result-${index}`} className="muted">
                  {results[model.id]!.message === '测试中…' ? '测试中…' : results[model.id]!.ok ? `连接成功（HTTP ${results[model.id]!.status}，${results[model.id]!.latencyMs}ms）` : `连接失败：${results[model.id]!.message ?? '未知原因'}`}
                </span>}
                <div className="topbar-spacer" />
                <Button size="sm" variant="danger" onClick={() => mutate(next => { next.models!.entries.splice(index, 1); })}>删除模型</Button>
              </div>
            </div>
          </div>
        ))}
      </Card>

      <Card title="并发限制" icon="clock" subtitle="保存后立即对新请求生效；已有调用保留计数，不会中断在途请求">
        {!Object.keys(draft.limits?.credentials ?? {}).length && !Object.keys(draft.limits?.sharedGroups ?? {}).length && <p className="muted">尚未配置并发上限，使用运行时默认值。</p>}
        <div className="row">
          {Object.entries(draft.limits?.credentials ?? {}).map(([id, value], index) => (
            <div className="list-item" key={`cred-${id}`} style={{ padding: '8px 10px' }}>
              <Field label={`凭据 ${id} 上限`}><input className="input" style={{ width: 100 }} type="number" data-testid={`limit-credential-${index}`} value={value} onChange={event => mutate(next => { next.limits!.credentials![id] = Number(event.target.value); })} /></Field>
              <Button size="sm" variant="ghost" onClick={() => mutate(next => { delete next.limits!.credentials![id]; })}>移除</Button>
            </div>
          ))}
          {Object.entries(draft.limits?.sharedGroups ?? {}).map(([id, value], index) => (
            <div className="list-item" key={`group-${id}`} style={{ padding: '8px 10px' }}>
              <Field label={`共享组 ${id} 上限`}><input className="input" style={{ width: 100 }} type="number" data-testid={`limit-group-${index}`} value={value} onChange={event => mutate(next => { next.limits!.sharedGroups![id] = Number(event.target.value); })} /></Field>
              <Button size="sm" variant="ghost" onClick={() => mutate(next => { delete next.limits!.sharedGroups![id]; })}>移除</Button>
            </div>
          ))}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <Button size="sm" icon="plus" data-testid="limit-credential-add" onClick={() => mutate(next => { next.limits = { ...(next.limits ?? {}), credentials: { ...(next.limits?.credentials ?? {}), [credentialIds[0] ?? 'credential']: 2 } }; })}>添加凭据上限</Button>
          <Button size="sm" icon="plus" data-testid="limit-group-add" onClick={() => mutate(next => { next.limits = { ...(next.limits ?? {}), sharedGroups: { ...(next.limits?.sharedGroups ?? {}), 'group-1': 4 } }; })}>添加共享组上限</Button>
        </div>
      </Card>

      <Card title="模型偏好" icon="spark" subtitle="按等级列出首选模型 ID（逗号分隔），用于自动选择模型">
        <div className="card-grid">
          {GRADES.map(grade => (
            <Field key={grade} label={grade}>
              <input className="input" data-testid={`preference-${grade}`} value={(draft.models?.preferences?.[grade] ?? []).join(',')} placeholder="model-a, model-b" onChange={event => mutate(next => {
                const value = event.target.value.split(',').map(item => item.trim()).filter(Boolean);
                next.models = { entries: next.models?.entries ?? [], preferences: { ...(next.models?.preferences ?? {}), [grade]: value } };
              })} />
            </Field>
          ))}
        </div>
      </Card>
    </div>
  );
}
