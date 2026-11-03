import { ProviderLogin } from './ProviderLogin.tsx';
import { ProviderPicker } from './ProviderPicker.tsx';
import { ModelGradeOptions } from './model-grade-options.tsx';
import { useEffect, useMemo, useState } from 'react';
import { api } from './api.ts';
import { PROVIDER_TEMPLATES, PROVIDER_PRESETS, providerTemplate, type ProviderTemplate } from '../catalog/providers.ts';
import { buildTemplateConfigDocument, type TemplateSetupModel } from './setup.ts';
import { Button, Card, Field, Pill, toast } from './ui.tsx';

const SECRET_REF = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Status {
  tone: 'info' | 'success' | 'danger';
  text: string;
  testid?: string;
}

export function Setup({ onSaved }: { onSaved?: (() => void) | undefined } = {}) {
  const bridge = typeof window !== 'undefined' ? window.graph : undefined;
  const [providerId, setProviderId] = useState('openai');
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [customModels, setCustomModels] = useState<TemplateSetupModel[]>([]);
  const [credentialId, setCredentialId] = useState('openai');
  const [secretRef, setSecretRef] = useState('OPENAI_API_KEY');
  const [key, setKey] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [baseUrl, setBaseUrl] = useState(PROVIDER_TEMPLATES[0]!.baseUrl);
  const [apiType, setApiType] = useState<'openai-completions' | 'anthropic-messages'>(PROVIDER_TEMPLATES[0]!.api);
  const [projectId, setProjectId] = useState('');
  const [projectRoot, setProjectRoot] = useState('');
  const [revision, setRevision] = useState<number | null>(null);
  const [existing, setExisting] = useState<Record<string, unknown> | null>(null);
  const [loginConfigured, setLoginConfigured] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Status | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const preset = PROVIDER_PRESETS.find(item => item.id === providerId)!;
  const template: ProviderTemplate = {
    ...preset,
    docsUrl: preset.docsUrl ?? '',
    credentialRefHint: preset.credentialRef,
    models: providerTemplate(providerId)?.models ?? [],
  };
  useEffect(() => {
    let stopped = false;
    void api<{ credentials?: Record<string, { secretRef: string; resolved: boolean }>; platforms: { credentialRef: string; credentialConfigured: boolean }[] }>('/api/providers').then(result => {
      if (!stopped) {
        const credential = result.credentials?.[credentialId];
        setLoginConfigured(credential?.secretRef === secretRef ? credential.resolved : result.platforms.some(item => item.credentialRef === secretRef && item.credentialConfigured));
      }
    }).catch(() => undefined);
    return () => { stopped = true; };
  }, [credentialId, secretRef]);
  const chosenModels = useMemo<TemplateSetupModel[]>(() => [
    ...template.models.filter(model => selected[model.id]).map(model => ({ id: model.id, grade: model.grade, contextWindow: model.contextWindow, maxTokens: model.maxTokens })),
    ...customModels,
  ], [selected, customModels, template]);

  useEffect(() => {
    void api<{ revision: number; config: Record<string, unknown> }>('/api/config')
      .then(result => {
        setRevision(result.revision);
        setExisting(result.config);
      })
      .catch(error => setStatus({ tone: 'danger', text: `读取配置失败：${(error as Error).message}` }));
    void api<{ configured?: boolean }>('/api/startup').then(result => setConfigured(Boolean(result.configured))).catch(() => undefined);
  }, []);

  function chooseProvider(id: string) {
    const next = PROVIDER_PRESETS.find(item => item.id === id)!;
    setProviderId(id);
    setBaseUrl(next.baseUrl);
    setApiType(next.api);
    setCredentialId(next.id);
    setSecretRef((existing?.credentials as Record<string, { secretRef?: string }> | undefined)?.[id]?.secretRef ?? next.credentialRef);
    setSelected(Object.fromEntries((providerTemplate(id)?.models ?? []).map(model => [model.id, true])));
    setCustomModels([]);
    setErrors({});
    setTestResult(null);
  }

  function toggleModel(id: string) {
    setSelected(current => ({ ...current, [id]: !current[id] }));
  }

  function addCustomModel() {
    const id = `custom-${customModels.length + 1}`;
    setCustomModels(current => [...current, { id, grade: 'high', contextWindow: 128_000, maxTokens: 8_192 }]);
  }

  async function pickRoot() {
    const picked = await bridge?.pickDirectory();
    if (!picked) return;
    setProjectRoot(picked);
    if (!projectId) setProjectId(picked.split('/').filter(Boolean).pop()?.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'demo');
  }

  async function submit() {
    const found: Record<string, string> = {};
    if (!chosenModels.length) found.models = '至少选择一个模型（或添加自定义模型）';
    if (!SECRET_REF.test(secretRef)) found.secretRef = '凭据引用需为合法环境变量名';
    if (!/^[a-z0-9][a-z0-9-_]*$/.test(credentialId)) found.credentialId = '凭据 id 需以小写字母或数字开头，仅含小写字母、数字、- 和 _';
    try {
      const url = new URL(baseUrl);
      if (!['http:', 'https:'].includes(url.protocol)) found.baseUrl = '端点需为 http(s) URL';
    } catch {
      found.baseUrl = '端点需为 http(s) URL';
    }
    for (const model of chosenModels) {
      if (!model.id.trim()) found.models = '模型 id 不能为空';
      if (!(model.contextWindow > model.maxTokens)) found.models = `模型 ${model.id}：上下文窗口需大于最大输出`;
    }
    if (projectId && !/^[a-z0-9][a-z0-9-_]*$/.test(projectId)) found.projectId = '项目 id 规则同凭据 id';
    setErrors(found);
    setStatus(null);
    if (Object.keys(found).length) {
      toast('请先修正表单中的错误', 'danger');
      return;
    }
    if (revision === null) {
      setStatus({ tone: 'info', text: '当前守护进程未绑定配置文件；CLI 模式下请先创建 graph.config.json 再打开本页。' });
      return;
    }
    setBusy(true);
    try {
      // Keychain first, so the key never enters the config file.
      if (bridge && key.trim()) {
        const stored = await bridge.saveSecret(secretRef, key.trim());
        if (!stored.stored) {
          setStatus({ tone: 'danger', text: `密钥未写入系统钥匙串：${stored.message ?? '存储不可用'}。可以改用环境变量后重试。`, testid: 'setup-secret-error' });
          setKey('');
          return;
        }
        if (stored.applied === false) {
          setStatus({ tone: 'info', text: `密钥已写入钥匙串，但守护进程尚未应用：${stored.message ?? '等待下次连接'}`, testid: 'setup-secret-pending' });
        }
      }
      const current = (await api<{ revision: number; config: Record<string, unknown> }>('/api/config')).config;
      const document = buildTemplateConfigDocument(current, { providerId, api: apiType, baseUrl, credentialId, secretRef, models: chosenModels }, template.models.map(model => ({ id: model.id, grade: model.grade, contextWindow: model.contextWindow, maxTokens: model.maxTokens })));
      if (projectId && projectRoot) {
        const projects = Array.isArray(document.projects) ? [...document.projects as Record<string, unknown>[]] : [];
        const index = projects.findIndex(project => (project as { id?: unknown }).id === projectId);
        const entry = { id: projectId, root: projectRoot.trim() };
        if (index >= 0) projects[index] = entry; else projects.push(entry);
        document.projects = projects;
      }
      const saved = await api<{ revision: number; effectiveRevision?: number; applied?: boolean; reason?: string; configured?: boolean }>('/api/config', {
        method: 'POST',
        body: JSON.stringify({ expectedRevision: revision, document }),
      });
      setRevision(saved.effectiveRevision ?? saved.revision);
      setConfigured(Boolean(saved.configured));
      setKey('');
      if (saved.applied === false) {
        setStatus({ tone: 'info', text: `配置已保存但未生效（revision ${saved.revision}）：${saved.reason ?? '请检查冲突后重试'}`, testid: 'setup-status' });
        toast('配置已保存，等待生效', 'info');
      } else {
        setStatus({
          tone: saved.configured === false ? 'info' : 'success',
          text: `已保存并应用（revision ${saved.effectiveRevision ?? saved.revision}）${saved.configured === false ? '；尚未解析到可用凭据，可稍后再填 key' : '，现在就可以开始对话'}`,
          testid: 'setup-status',
        });
        toast('连接已保存并应用', 'success');
      }
      setExisting(document);
      onSaved?.();
    } catch (error) {
      const failure = error as Error & { field?: string; code?: string };
      setStatus({ tone: 'danger', text: `保存失败（${failure.code ?? 'error'}）：${failure.message}`, testid: 'setup-status' });
      toast(`保存失败：${failure.message}`, 'danger');
    } finally {
      setBusy(false);
    }
  }

  async function testConnection(modelId: string) {
    setTestResult('测试中…');
    try {
      const result = await api<{ ok: boolean; status?: number; latencyMs?: number; message?: string }>('/api/config/test', { method: 'POST', body: JSON.stringify({ modelId }) });
      setTestResult(result.ok
        ? `连接成功：${modelId}，HTTP ${result.status ?? 200}，${result.latencyMs ?? 0}ms。这会发出一次最小模型调用并计费。`
        : `连接失败：${result.message ?? `HTTP ${result.status ?? '未知'}`}`);
    } catch (error) {
      setTestResult(`连接失败：${(error as Error).message}`);
    }
  }

  const reviewModel = chosenModels.find(model => model.grade === 'highest' || model.grade === 'high');
  return (
    <div className="stagger" data-testid="setup">
      <Card title="连接模型" icon="wizard" subtitle="选择服务商与认证方式，再选择模型；保存后立即生效，无需重启">
        {status && <div data-testid={status.testid ?? 'setup-status'} className="hint-card" style={{ display: 'block', borderColor: status.tone === 'danger' ? 'var(--danger)' : undefined }}>{status.text}</div>}
        <p className="muted" data-testid="setup-existing">
          {existing && ((existing.models as { entries?: unknown[] } | undefined)?.entries?.length ?? 0) > 0
            ? '已有配置。选择新平台会追加连接，不会覆盖已有平台。'
            : '还没有配置连接。选择服务商，填入 API key 或使用其浏览器授权入口。'}
        </p>

        <h3 className="section-title">平台</h3>
        <ProviderPicker choices={PROVIDER_PRESETS} value={providerId} onChange={chooseProvider} testId="setup-providers" testIdPrefix="setup-provider-" disabled={busy} />
        {preset.docsUrl && <p className="provider-help"><a href={preset.docsUrl} target="_blank" rel="noreferrer">获取 {preset.label} API 凭据 ↗</a></p>}
        {template.notes.length > 0 && <p className="muted">{template.notes.join('；')}</p>}

        {preset.oauthProvider && <ProviderLogin key={`${preset.oauthProvider}:${secretRef}`} providerId={preset.oauthProvider} credentialRef={secretRef} configured={loginConfigured} onChange={setLoginConfigured} />}
        <h3 className="section-title">{preset.credentialKind === 'subscription' ? '订阅访问令牌' : 'API key'}</h3>
        {bridge
          ? <Field label="API 密钥" hint="只写入系统钥匙串；不进入配置文件、日志或页面状态">
              <input className="input" style={{ maxWidth: 'none' }} type="password" data-testid="setup-key" value={key} onChange={event => setKey(event.target.value)} placeholder="sk-…" />
            </Field>
          : <p className="muted">浏览器模式：请设置环境变量 <code>{secretRef}</code>，保存后重试。</p>}
        <div className="card-grid">
          <Field label="凭据引用" hint="配置文件中只出现这个名字" error={errors.secretRef}>
            <input className="input" data-testid="setup-secret-ref" data-invalid={Boolean(errors.secretRef)} value={secretRef} onChange={event => setSecretRef(event.target.value)} />
          </Field>
          <Field label="凭据 id" error={errors.credentialId}>
            <input className="input" data-testid="setup-credential-id" data-invalid={Boolean(errors.credentialId)} value={credentialId} onChange={event => setCredentialId(event.target.value)} />
          </Field>
        </div>

        <h3 className="section-title">推荐模型组合</h3>
        {template.models.length === 0 && <p className="muted">该平台需要手动填写模型（高级设置）。</p>}
        <div data-testid="setup-models">
          {template.models.map(model => (
            <label key={model.id} className="list-item" style={{ cursor: 'pointer' }}>
              <input type="checkbox" data-testid={`setup-model-${model.id}`} checked={Boolean(selected[model.id])} onChange={() => toggleModel(model.id)} />
              <span className="grow">{model.id} <span className="muted">{model.grade} · 上下文 {model.contextWindow.toLocaleString('en-US')} · 输出 {model.maxTokens.toLocaleString('en-US')} · {model.pricing ? `${model.pricing.currency} 参考价（${model.pricing.status}${model.pricing.retrievedAt ? ` · ${model.pricing.retrievedAt}` : ''}${model.pricing.sourceUrl ? ` · ${(() => { try { return new URL(model.pricing.sourceUrl!).host; } catch { return model.pricing.sourceUrl; } })()}` : ''}）` : '价格未知'}</span></span>
            </label>
          ))}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <Button size="sm" icon="plus" data-testid="setup-model-add" onClick={addCustomModel}>添加自定义模型</Button>
        </div>
        {customModels.map((model, index) => (
          <div className="list-item" key={index} data-testid={`setup-custom-model-${index}`}>
            <input className="input" style={{ width: 200 }} value={model.id} onChange={event => setCustomModels(current => current.map((item, position) => position === index ? { ...item, id: event.target.value } : item))} />
            <select className="select" value={model.grade} onChange={event => setCustomModels(current => current.map((item, position) => position === index ? { ...item, grade: event.target.value as TemplateSetupModel['grade'] } : item))}>
              <ModelGradeOptions />
            </select>
            <Button size="sm" variant="danger" onClick={() => setCustomModels(current => current.filter((_, position) => position !== index))}>删除</Button>
          </div>
        ))}
        <p className="muted">
          主 Agent 与审查使用等级最高的模型（推荐 {reviewModel?.id ?? '（尚未选择）'}），实现使用 medium/high。
          {chosenModels.length === 1 ? ' 当前只有一个模型：可以聊天，但需要独立审查的派发会明确提示缺少第二个模型，不会偷偷放宽审查规则。' : ''}
        </p>

        <h3 className="section-title">高级设置</h3>
        <Button size="sm" data-testid="setup-advanced-toggle" onClick={() => setAdvanced(value => !value)}>{advanced ? '收起高级设置' : '展开高级设置'}</Button>
        {advanced && (
          <div style={{ marginTop: 10 }}>
            <div className="card-grid">
              <Field label="传输" hint="只有经验证的传输可以派发">
                <select className="select" data-testid="setup-api" value={apiType} onChange={event => setApiType(event.target.value as typeof apiType)}>
                  <option value="openai-completions">OpenAI Chat Completions</option>
                  <option value="anthropic-messages">Anthropic Messages</option>
                </select>
              </Field>
              <Field label="端点" error={errors.baseUrl}>
                <input className="input" style={{ maxWidth: 'none' }} data-testid="setup-base-url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} />
              </Field>
            </div>
            <h4 className="section-title">项目（可选）</h4>
            <div className="card-grid">
              <Field label="项目 id" error={errors.projectId}>
                <input className="input" data-testid="setup-project-id" value={projectId} onChange={event => setProjectId(event.target.value)} placeholder="demo" />
              </Field>
              <Field label="项目路径">
                <div className="row">
                  <input className="input" style={{ flex: 1, minWidth: 220, maxWidth: 'none' }} data-testid="setup-project-root" value={projectRoot} onChange={event => setProjectRoot(event.target.value)} placeholder="/path/to/project" />
                  {bridge && <Button icon="box" onClick={() => void pickRoot()}>选择目录</Button>}
                </div>
              </Field>
            </div>
          </div>
        )}

        <div className="row" style={{ marginTop: 16 }}>
          <Button variant="primary" size="lg" icon="check" disabled={busy || revision === null} onClick={() => void submit()} data-testid="setup-save">
            {busy ? '保存中…' : '保存并应用'}
          </Button>
          <Button size="lg" data-testid="setup-test" disabled={revision === null || configured === false} onClick={() => void testConnection(chosenModels[0]?.id ?? '')}>测试连接</Button>
          {revision !== null && <Pill>revision {revision}</Pill>}
          {configured !== null && <Pill tone={configured ? 'success' : 'warn'}>{configured ? '已连接' : '未连接'}</Pill>}
        </div>
        {testResult && <p className="muted" data-testid="setup-test-result">{testResult}</p>}
      </Card>
    </div>
  );
}
