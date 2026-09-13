import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { api } from './api.ts';

type Cost = { input: number; output: number; cacheRead: number; cacheWrite: number };
type RawModel = {
  id: string; provider: string; grade: string; api: 'openai-completions'; baseUrl: string;
  contextWindow: number; maxTokens: number; credentialId: string; cost?: Cost;
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
type ApiError = Error & { code?: string; field?: string };

const GRADES = ['low', 'medium', 'high', 'highest'];
const input: CSSProperties = { padding: '4px 6px', margin: 2, border: '1px solid #bbb', borderRadius: 4 };
const row: CSSProperties = { border: '1px solid #ddd', borderRadius: 6, padding: 8, margin: '6px 0' };

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

export function Settings() {
  const [draft, setDraft] = useState<RawConfig | null>(null);
  const [credentialState, setCredentialState] = useState<Record<string, boolean>>({});
  const [revision, setRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [results, setResults] = useState<Record<string, TestResult>>({});

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

  if (!draft) return <section data-testid="settings-page"><p data-testid="settings-loading">加载配置中…</p>{error && <p data-testid="config-error">{error.message}</p>}</section>;

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
      const response = await api<{ revision: number; restartRequired: boolean }>('/api/config', {
        method: 'POST',
        body: JSON.stringify({ expectedRevision: revision, document: { ...draft, version: 1 } }),
      });
      setRevision(response.revision);
      setDirty(false);
      setStatus(`已保存 revision ${response.revision}`);
      await load();
      setStatus(`已保存 revision ${response.revision}${response.restartRequired ? '，重启守护进程后生效' : ''}`);
    } catch (reason) {
      setError(reason as ApiError);
    } finally {
      setSaving(false);
    }
  };
  const testConnection = async (model: RawModel) => {
    setResults(current => ({ ...current, [model.id]: { ok: false, message: '测试中…' } as TestResult }));
    try {
      const result = await api<TestResult>('/api/config/test', { method: 'POST', body: JSON.stringify({ modelId: model.id }) });
      setResults(current => ({ ...current, [model.id]: result }));
    } catch (reason) {
      setResults(current => ({ ...current, [model.id]: { ok: false, message: (reason as Error).message } }));
    }
  };

  const projects = draft.projects ?? [];
  const models = draft.models?.entries ?? [];
  const credentials = Object.entries(draft.credentials ?? {});
  const credentialIds = credentials.map(([id]) => id);
  const fieldError = (field: string): CSSProperties => error?.field === field ? { outline: '2px solid #d33' } : {};

  return (
    <section data-testid="settings-page">
      <h1>设置</h1>
      <p>
        配置版本 revision <span data-testid="config-revision">{revision}</span>
        {dirty ? '（有未保存修改）' : '（已同步）'} · 保存后需重启守护进程生效
      </p>
      <div>
        <button type="button" data-testid="settings-save" disabled={saving || !dirty} onClick={() => void save()}>{saving ? '保存中…' : '保存配置'}</button>
        <button type="button" data-testid="settings-reload" onClick={() => void load()}>重新加载</button>
      </div>
      {error && <p data-testid="config-error">{error.message}{error.code ? `（${error.code}）` : ''}</p>}
      {status && <p data-testid="config-status">{status}</p>}
      {status.includes('重启') && <p data-testid="restart-required">待生效：当前守护进程仍使用启动时的绑定，重启后应用新配置。</p>}

      <h2>项目</h2>
      {projects.map((project, index) => (
        <div style={{ display: 'flex', flexWrap: 'wrap' }} key={index} data-testid={`project-row-${index}`} data-row={index}>
          <label>项目 ID<input style={{ ...input, ...fieldError(`projects[${index}].id`) }} data-testid={`project-${index}-id`} value={project.id} onChange={event => mutate(next => { next.projects![index]!.id = event.target.value; })} /></label>
          <label>根目录<input style={{ ...input, ...fieldError(`projects[${index}].root`) }} data-testid={`project-${index}-root`} size={40} value={project.root} onChange={event => mutate(next => { next.projects![index]!.root = event.target.value; })} /></label>
          <button type="button" onClick={() => mutate(next => { next.projects!.splice(index, 1); })}>删除</button>
        </div>
      ))}
      <button type="button" data-testid="project-add" onClick={() => mutate(next => { next.projects = [...(next.projects ?? []), { id: 'new-project', root: '.' }]; })}>添加项目</button>

      <h2>凭据引用</h2>
      <p>只保存环境变量名；密钥本身从不进入配置文件、接口响应或页面。</p>
      {credentials.map(([id, credential], index) => (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center' }} key={id} data-testid={`credential-row-${index}`} data-id={id}>
          <label>ID<input style={input} data-testid={`credential-${index}-id`} value={id} onChange={event => mutate(next => {
            const record = next.credentials!;
            const value = record[id]!;
            delete record[id];
            record[event.target.value] = value;
          })} /></label>
          <label>环境变量<input style={input} data-testid={`credential-${index}-secretRef`} value={credential.secretRef} onChange={event => mutate(next => { next.credentials![id]!.secretRef = event.target.value; })} /></label>
          <label>共享组<input style={input} data-testid={`credential-${index}-group`} value={credential.sharedLimitGroupId ?? ''} onChange={event => mutate(next => {
            const value = next.credentials![id]!;
            if (event.target.value) value.sharedLimitGroupId = event.target.value;
            else delete value.sharedLimitGroupId;
          })} /></label>
          <span data-testid={`credential-${index}-state`}>{credentialState[id] ? '已配置' : '缺失'}</span>
          <button type="button" onClick={() => mutate(next => { delete next.credentials![id]; })}>删除</button>
        </div>
      ))}
      <button type="button" data-testid="credential-add" onClick={() => mutate(next => { next.credentials = { ...(next.credentials ?? {}), 'new-credential': { secretRef: 'GRAPH_NEW_KEY' } }; })}>添加凭据</button>

      <h2>模型</h2>
      {models.map((model, index) => (
        <div style={row} key={index} data-testid={`model-row-${index}`}>
          <div style={{ display: 'flex', flexWrap: 'wrap' }}>
            <label>ID<input style={{ ...input, ...fieldError(`models.entries[${index}].id`) }} data-testid={`model-${index}-id`} value={model.id} onChange={event => mutate(next => { next.models!.entries[index]!.id = event.target.value; })} /></label>
            <label>Provider<input style={input} data-testid={`model-${index}-provider`} value={model.provider} onChange={event => mutate(next => { next.models!.entries[index]!.provider = event.target.value; })} /></label>
            <label>等级<select style={input} data-testid={`model-${index}-grade`} value={model.grade} onChange={event => mutate(next => { next.models!.entries[index]!.grade = event.target.value; })}>{GRADES.map(grade => <option key={grade} value={grade}>{grade}</option>)}</select></label>
            <label>凭据<select style={{ ...input, ...fieldError(`models.entries[${index}].credentialId`) }} data-testid={`model-${index}-credentialId`} value={model.credentialId} onChange={event => mutate(next => { next.models!.entries[index]!.credentialId = event.target.value; })}>
              {!credentialIds.includes(model.credentialId) && <option value={model.credentialId}>{model.credentialId || '（未选择）'}</option>}
              {credentialIds.map(id => <option key={id} value={id}>{id}（{credentialState[id] ? '已配置' : '缺失'}）</option>)}
            </select></label>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap' }}>
            <label>Base URL<input style={{ ...input, ...fieldError(`models.entries[${index}].baseUrl`) }} size={32} data-testid={`model-${index}-baseUrl`} value={model.baseUrl} onChange={event => mutate(next => { next.models!.entries[index]!.baseUrl = event.target.value; })} /></label>
            <label>上下文<input style={input} type="number" data-testid={`model-${index}-context`} value={model.contextWindow} onChange={event => mutate(next => { next.models!.entries[index]!.contextWindow = Number(event.target.value); })} /></label>
            <label>最大输出<input style={input} type="number" data-testid={`model-${index}-maxTokens`} value={model.maxTokens} onChange={event => mutate(next => { next.models!.entries[index]!.maxTokens = Number(event.target.value); })} /></label>
            <label>输入价/百万<input style={input} type="number" data-testid={`model-${index}-input-cost`} value={model.cost?.input ?? ''} placeholder="未知" onChange={event => mutate(next => {
              const entry = next.models!.entries[index]!;
              const value = Number(event.target.value);
              if (event.target.value === '' || !Number.isFinite(value)) { delete entry.cost; return; }
              entry.cost = { input: value, output: entry.cost?.output ?? 0, cacheRead: entry.cost?.cacheRead ?? 0, cacheWrite: entry.cost?.cacheWrite ?? 0 };
            })} /></label>
            <label>输出价/百万<input style={input} type="number" data-testid={`model-${index}-output-cost`} value={model.cost?.output ?? ''} placeholder="未知" onChange={event => mutate(next => {
              const entry = next.models!.entries[index]!;
              const value = Number(event.target.value);
              if (event.target.value === '' || !Number.isFinite(value)) { delete entry.cost; return; }
              entry.cost = { input: entry.cost?.input ?? 0, output: value, cacheRead: entry.cost?.cacheRead ?? 0, cacheWrite: entry.cost?.cacheWrite ?? 0 };
            })} /></label>
          </div>
          <p data-testid={`model-${index}-price`}>{model.cost ? `价格 输入 ${model.cost.input}/输出 ${model.cost.output} 每百万 token` : '价格未知（未配置，不会按 0 计算）'}</p>
          <button type="button" data-testid={`model-${index}-test`} onClick={() => void testConnection(model)}>测试连接（可能产生用量）</button>
          {results[model.id] && <span data-testid={`connection-result-${index}`}>{results[model.id]!.message === '测试中…' ? '测试中…' : results[model.id]!.ok ? `连接成功（HTTP ${results[model.id]!.status}，${results[model.id]!.latencyMs}ms）` : `连接失败：${results[model.id]!.message ?? '未知原因'}`}</span>}
          <button type="button" onClick={() => mutate(next => { next.models!.entries.splice(index, 1); })}>删除模型</button>
        </div>
      ))}
      <button type="button" data-testid="model-add" onClick={() => mutate(next => { next.models = { entries: [...(next.models?.entries ?? []), { ...emptyModel(), credentialId: credentialIds[0] ?? '' }] }; })}>添加模型</button>

      <h2>并发限制</h2>
      <p>上限在守护进程启动时绑定；修改后重启生效，不会中断在途请求。</p>
      {Object.entries(draft.limits?.credentials ?? {}).map(([id, value], index) => (
        <div key={`cred-${id}`}><label>凭据 {id} 上限<input style={input} type="number" data-testid={`limit-credential-${index}`} value={value} onChange={event => mutate(next => { next.limits!.credentials![id] = Number(event.target.value); })} /></label>
          <button type="button" onClick={() => mutate(next => { delete next.limits!.credentials![id]; })}>移除</button></div>
      ))}
      {Object.entries(draft.limits?.sharedGroups ?? {}).map(([id, value], index) => (
        <div key={`group-${id}`}><label>共享组 {id} 上限<input style={input} type="number" data-testid={`limit-group-${index}`} value={value} onChange={event => mutate(next => { next.limits!.sharedGroups![id] = Number(event.target.value); })} /></label>
          <button type="button" onClick={() => mutate(next => { delete next.limits!.sharedGroups![id]; })}>移除</button></div>
      ))}
      <button type="button" data-testid="limit-credential-add" onClick={() => mutate(next => { next.limits = { ...(next.limits ?? {}), credentials: { ...(next.limits?.credentials ?? {}), [credentialIds[0] ?? 'credential']: 2 } }; })}>添加凭据上限</button>
      <button type="button" data-testid="limit-group-add" onClick={() => mutate(next => { next.limits = { ...(next.limits ?? {}), sharedGroups: { ...(next.limits?.sharedGroups ?? {}), 'group-1': 4 } }; })}>添加共享组上限</button>

      <h2>模型偏好</h2>
      <p>按等级列出首选模型 ID（逗号分隔），用于自动选择模型。</p>
      {GRADES.map(grade => (
        <label key={grade}>{grade}<input style={input} data-testid={`preference-${grade}`} value={(draft.models?.preferences?.[grade] ?? []).join(',')} onChange={event => mutate(next => {
          const value = event.target.value.split(',').map(item => item.trim()).filter(Boolean);
          next.models = { entries: next.models?.entries ?? [], preferences: { ...(next.models?.preferences ?? {}), [grade]: value } };
        })} /></label>
      ))}
    </section>
  );
}
