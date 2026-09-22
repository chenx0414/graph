import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { usePreferences } from './preferences.ts';
import { Setup } from './Setup.tsx';
import { Button, Card, Field, Icon, Pill, Spinner, toast } from './ui.tsx';
import { STANDARD_ACCESS } from './access-presets.ts';
import type { AccessPolicy } from '../core/access-policy.ts';
import type { ModelInput } from '../catalog/models.ts';

type Cost = { input: number; output: number; cacheRead: number; cacheWrite: number };
type ModelThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const THINKING_LEVELS: ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
type RawModel = {
  id: string; provider: string; modelId?: string; grade: string; api: 'openai-completions' | 'anthropic-messages'; baseUrl: string;
  contextWindow: number; maxTokens: number; reasoning?: boolean; defaultThinkingLevel?: ModelThinkingLevel; credentialId: string; cost?: Cost;
  input?: ModelInput[];
  pricing?: { currency: string; unit: 'per_million_tokens'; status: 'known' | 'stale' | 'unknown'; sourceUrl?: string };
  headers?: Record<string, string>;
};
type RawCredential = { secretRef: string; displayName?: string; sharedLimitGroupId?: string };
type RawConfig = {
  version: 1;
  projects?: { id: string; root: string; grants?: string[] }[];
  models?: { entries: RawModel[] };
  credentials?: Record<string, RawCredential>;
  limits?: { credentials?: Record<string, number>; sharedGroups?: Record<string, number> };
  access?: AccessPolicy;
};
type ConfigResponse = { revision: number; config: RawConfig & { path: string | null; credentials?: Record<string, RawCredential & { configured?: boolean }> } };
type TestResult = { ok: boolean; model?: string; credentialId?: string; status?: number; latencyMs?: number; message?: string };
type Startup = { effectiveRevision?: number };
type SubscriptionModel = {
  id: string;
  name: string;
  api: 'openai-completions' | 'anthropic-messages' | 'responses';
  baseUrl: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  supported: boolean;
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
  cacheReadCostPerMillion?: number;
  cacheCreationCostPerMillion?: number;
  headers?: Record<string, string>;
};
type SubscriptionPlan = {
  id: string;
  name: string;
  configured: boolean;
  credential?: { id: string; secretRef: string; source: string; configured: boolean } | null;
  models: SubscriptionModel[];
};
type UsageResponse = { plans: SubscriptionPlan[] };
type ApiError = Error & { code?: string; field?: string };

const GRADES = ['low', 'medium', 'high', 'highest'];

function emptyModel(): RawModel {
  return {
    id: 'new-model',
    provider: 'local',
    grade: 'medium',
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:8080/v1',
    contextWindow: 32768,
    maxTokens: 4096,
    input: ['text'],
    reasoning: true,
    defaultThinkingLevel: 'medium',
    credentialId: '',
  };
}

function uniqueModelId(planId: string, modelId: string, entries: RawModel[], currentIndex?: number): string {
  const base = `${planId}:${modelId}`;
  let candidate = base;
  let suffix = 2;
  while (entries.some((entry, index) => index !== currentIndex && entry.id === candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}

function subscriptionCost(model: SubscriptionModel): Cost | undefined {
  if (
    model.inputCostPerMillion === undefined
    || model.outputCostPerMillion === undefined
    || model.cacheReadCostPerMillion === undefined
  ) return undefined;
  return {
    input: model.inputCostPerMillion,
    output: model.outputCostPerMillion,
    cacheRead: model.cacheReadCostPerMillion,
    cacheWrite: model.cacheCreationCostPerMillion ?? 0,
  };
}

function modelFromSubscription(plan: SubscriptionPlan, model: SubscriptionModel, entries: RawModel[], currentIndex?: number): RawModel {
  const cost = subscriptionCost(model);
  const headers = plan.id === 'opencode-go'
    ? { 'x-opencode-session': 'graph-console', ...(model.headers ?? {}) }
    : model.headers;
  return {
    id: uniqueModelId(plan.id, model.id, entries, currentIndex),
    provider: plan.id,
    modelId: model.id,
    grade: 'medium',
    api: model.api === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions',
    baseUrl: model.baseUrl,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    input: ['text'],
    reasoning: model.reasoning,
    defaultThinkingLevel: model.reasoning ? 'medium' : 'off',
    credentialId: plan.credential?.id ?? plan.id,
    ...(headers ? { headers } : {}),
    ...(cost ? { cost, pricing: { currency: 'USD', unit: 'per_million_tokens' as const, status: 'known' as const, sourceUrl: 'model-pricing.json' } } : {}),
  };
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
    ...(config.models ? { models: { entries: config.models.entries } } : {}),
    credentials,
    limits: config.limits ?? {},
    access: config.access ?? STANDARD_ACCESS,
  };
}

function mergeSubscriptionCredentials(config: RawConfig, detected: Record<string, string>): { config: RawConfig; changed: boolean } {
  const credentials = { ...(config.credentials ?? {}) };
  let changed = false;
  for (const [provider, secretRef] of Object.entries(detected)) {
    if (credentials[provider]) continue;
    credentials[provider] = { secretRef, displayName: `${provider} 订阅` };
    changed = true;
  }
  return changed ? { config: { ...config, credentials }, changed: true } : { config, changed: false };
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

type ArchivedConversation = {
  id: string; title: string; projectId: string | null; createdAt: number; archivedAt: number | null;
};

function ArchivedConversations() {
  const [items, setItems] = useState<ArchivedConversation[] | null>(null);
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    const data = await api<ArchivedConversation[]>('/api/conversations?archived=true');
    setItems(data);
  }, []);
  useEffect(() => { void load().catch(() => setItems([])); }, [load]);
  async function restore(conversation: ArchivedConversation) {
    if (busy) return;
    setBusy(conversation.id);
    try {
      await api(`/api/conversations/${conversation.id}/unarchive`, {
        method: 'POST',
        body: JSON.stringify({ requestId: `unarchive-${crypto.randomUUID()}` }),
      });
      toast('对话已取消归档并回到原项目。', 'success');
      window.dispatchEvent(new Event('graph:conversations-changed'));
      await load();
    } catch (reason) {
      toast(`取消归档失败：${reason instanceof Error ? reason.message : String(reason)}`, 'danger');
    } finally {
      setBusy('');
    }
  }
  return (
    <Card title="归档对话" icon="archive" subtitle="归档不会删除消息或任务记录；取消归档后会回到原来的项目或“最近”">
      {items === null && <Spinner />}
      {items?.length === 0 && <p className="muted" data-testid="archived-empty">还没有归档对话。</p>}
      {items?.map(conversation => (
        <div className="list-item" key={conversation.id} data-testid={`archived-conversation-${conversation.id}`}>
          <div className="grow">
            <a href={`#/conversations/${conversation.id}`}>{conversation.title}</a>
            <div className="muted">
              {conversation.projectId ?? '最近'}
              {conversation.archivedAt ? ` · 归档于 ${new Date(conversation.archivedAt).toLocaleString()}` : ''}
            </div>
          </div>
          <Button size="sm" icon="refresh" disabled={busy === conversation.id} onClick={() => void restore(conversation)}>
            {busy === conversation.id ? '恢复中…' : '取消归档'}
          </Button>
        </div>
      ))}
    </Card>
  );
}

/**
 * Local rendering preferences. They live in `localStorage` (graph-pref-*) and
 * are never saved to the server config, so toggling one is instant and offline.
 */
function PreferencesPage() {
  const { preferences, update } = usePreferences();
  return (
    <section id="settings-general" className="settings-section" data-testid="settings-preferences">
      <Card title="通用" icon="settings" subtitle="这些偏好保存在本机浏览器，不会写入配置文件，也不需要重启守护进程">
        <div className="preference-list">
          <label className="preference-item">
            <span className="preference-copy">
              <strong>Markdown 渲染</strong>
              <span className="muted">开启后你与主 Agent 的消息都按 Markdown 渲染；关闭后显示原文。</span>
            </span>
            <input
              type="checkbox"
              className="preference-toggle"
              data-testid="pref-markdown"
              checked={preferences.markdownRendering}
              onChange={event => update('markdownRendering', event.target.checked)}
            />
          </label>
          <label className="preference-item">
            <span className="preference-copy">
              <strong>候选 prompt</strong>
              <span className="muted">开启后，输入框为空且主 Agent 空闲时显示建议的下一步 prompt。</span>
            </span>
            <input
              type="checkbox"
              className="preference-toggle"
              data-testid="pref-candidate-prompt"
              checked={preferences.candidatePrompt}
              onChange={event => update('candidatePrompt', event.target.checked)}
            />
          </label>
        </div>
      </Card>
    </section>
  );
}

function ThemePlaceholder() {
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>('system');
  const options = [
    { id: 'system', label: '系统' },
    { id: 'light', label: '浅色' },
    { id: 'dark', label: '深色' },
  ] as const;
  return (
    <section className="settings-feature" data-testid="theme-placeholder">
      <h2>主题</h2>
      <div className="theme-options">
        {options.map(option => (
          <button
            key={option.id}
            type="button"
            className="theme-option"
            data-active={theme === option.id}
            data-testid={`theme-${option.id}`}
            onClick={() => setTheme(option.id)}
            aria-pressed={theme === option.id}
          >
            <span className={`theme-preview theme-preview-${option.id}`}>
              <span className="theme-preview-side" />
              <span className="theme-preview-card">
                <span className="theme-preview-line theme-preview-line-strong" />
                <span className="theme-preview-line" />
                <span className="theme-preview-line theme-preview-line-short" />
              </span>
            </span>
            <span className="theme-option-label">{option.label}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function Settings({ openGuide = false }: { openGuide?: boolean } = {}) {
  const [active, setActive] = useState(openGuide ? 'settings-models' : 'settings-overview');
  const [search, setSearch] = useState('');
  useEffect(() => {
    setActive(openGuide ? 'settings-models' : 'settings-overview');
  }, [openGuide]);
  const sections = [
    { id: 'settings-general', label: '通用/偏好' },
    { id: 'settings-overview', label: '常规' },
    { id: 'settings-git', label: 'Git 准备' },
    { id: 'settings-models', label: '模型' },
    { id: 'settings-archived', label: '归档对话' },
  ];
  const visibleSections = sections.filter(section => section.label.toLowerCase().includes(search.trim().toLowerCase()));
  function go(id: string) {
    setActive(id);
  }
  return (
    <div className="settings-app-shell" data-testid="settings-shell">
      <aside className="settings-sidebar">
        <a className="settings-back" href="#/">
          <Icon name="chevron" className="settings-back-icon" size={16} />
          <span>返回应用</span>
        </a>
        <label className="settings-search">
          <Icon name="search" size={15} />
          <input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索设置…" aria-label="搜索设置" />
        </label>
        <nav className="settings-nav" aria-label="设置导航">
          {visibleSections.map(section => (
            <button key={section.id} type="button" className="settings-nav-item" data-active={active === section.id} onClick={() => go(section.id)}>
              <Icon name={section.id === 'settings-models' ? 'bolt' : section.id === 'settings-archived' ? 'archive' : section.id === 'settings-git' ? 'box' : 'settings'} size={16} />
              <span>{section.label}</span>
            </button>
          ))}
          {!visibleSections.length && <span className="settings-nav-empty">没有匹配的设置</span>}
        </nav>
      </aside>
      <main className="settings-main">
        <header className="settings-main-header">
          <div>
            <h1>{sections.find(section => section.id === active)?.label ?? '设置'}</h1>
            <p>配置会在保存后立即应用到当前守护进程。</p>
          </div>
        </header>
        <div className="settings-content">
          <div className="settings-root">
            <SettingsAdvanced active={active} autoSyncSubscriptions={!openGuide} />
            {active === 'settings-general' && <PreferencesPage />}
            {active === 'settings-archived' && <section id="settings-archived" className="settings-section"><ArchivedConversations /></section>}
          </div>
        </div>
      </main>
    </div>
  );
}

function SettingsAdvanced({ active, autoSyncSubscriptions }: { active: string; autoSyncSubscriptions: boolean }) {
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
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [plansLoading, setPlansLoading] = useState(false);
  const [plansError, setPlansError] = useState('');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saveInFlight = useRef(false);
  const savePending = useRef(false);
  const latestDraft = useRef<RawConfig | null>(null);
  const latestRevision = useRef(0);
  const editVersion = useRef(0);
  const bridge = typeof window !== 'undefined' ? window.graph : undefined;

  const load = useCallback(async () => {
    try {
      const [response, detectedResponse] = await Promise.all([
        api<ConfigResponse>('/api/config'),
        autoSyncSubscriptions
          ? api<{ credentials: Record<string, string> }>('/api/usage/credentials').catch(() => ({ credentials: {} }))
          : Promise.resolve({ credentials: {} }),
      ]);
      const detected = detectedResponse.credentials;
      const merged = mergeSubscriptionCredentials(toDraft(response.config), detected);
      const next = merged.config;
      clearTimeout(saveTimer.current);
      editVersion.current = merged.changed ? 1 : 0;
      savePending.current = false;
      latestDraft.current = next;
      latestRevision.current = response.revision;
      setDraft(next);
      setCredentialState({
        ...Object.fromEntries(Object.entries(response.config.credentials ?? {}).map(([id, credential]) => [id, Boolean(credential.configured)])),
        ...Object.fromEntries(Object.keys(detected).map(id => [id, true])),
      });
      setRevision(response.revision);
      setDirty(merged.changed);
      setError(null);
      setStatus(merged.changed ? `已同步 ${Object.keys(detected).join('、')} 的凭据引用` : '');
      if (merged.changed) scheduleSave(0);
    } catch (reason) {
      setError(reason as ApiError);
    }
  }, [autoSyncSubscriptions]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (active !== 'settings-models') return;
    let cancelled = false;
    setPlansLoading(true);
    setPlansError('');
    void api<UsageResponse>('/api/usage').then(result => {
      if (!cancelled) setPlans(result.plans.filter(plan => plan.configured));
    }).catch(reason => {
      if (!cancelled) setPlansError((reason as Error).message);
    }).finally(() => {
      if (!cancelled) setPlansLoading(false);
    });
    return () => { cancelled = true; };
  }, [active]);
  useEffect(() => () => {
    clearTimeout(saveTimer.current);
    if (editVersion.current > 0) void persistDraft(editVersion.current);
  }, []);
  useEffect(() => { void api<Startup>('/api/startup').then(startup => setEffectiveRevision(startup.effectiveRevision ?? null)).catch(() => undefined); }, []);

  const configurationPage = ['settings-overview', 'settings-git', 'settings-models'].includes(active);
  if (!configurationPage) return <div className="settings-page-empty" data-testid="settings-page" data-page={active} />;
  if (!draft) return (
    <div className="settings-page-loading" data-testid="settings-page" data-page={active}>
      <Card><p data-testid="settings-loading"><Spinner label="加载配置中…" /></p>{error && <p data-testid="config-error" style={{ color: 'var(--danger)' }}>{error.message}</p>}</Card>
    </div>
  );

  function scheduleSave(delay = 550) {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void persistDraft(editVersion.current), delay);
  }
  async function persistDraft(version: number) {
    if (saveInFlight.current) {
      savePending.current = true;
      return;
    }
    if (version !== editVersion.current) {
      scheduleSave(100);
      return;
    }
    const document = latestDraft.current;
    if (!document) return;
    const expectedRevision = latestRevision.current;
    saveInFlight.current = true;
    savePending.current = false;
    setSaving(true);
    setError(null);
    try {
      const response = await api<{ revision: number; effectiveRevision?: number; restartRequired: boolean; applied?: boolean; reason?: string; configured?: boolean }>('/api/config', {
        method: 'POST',
        body: JSON.stringify({
          expectedRevision,
          document: { ...document, version: 1 },
        }),
      });
      latestRevision.current = response.revision;
      setRevision(response.revision);
      setEffectiveRevision(response.effectiveRevision ?? response.revision);
      const pending = response.applied === false;
      setStatus(`已自动保存 revision ${response.revision}${pending ? `，等待生效：${response.reason ?? '需要重启守护进程'}` : '，已应用到当前守护进程'}${response.configured === false ? '（尚未配置可用凭据，仅查看模式）' : ''}`);
      if (editVersion.current === version) {
        editVersion.current = 0;
        setDirty(false);
      } else {
        savePending.current = true;
      }
    } catch (reason) {
      setError(reason as ApiError);
      setDirty(true);
      toast(`自动保存失败：${(reason as Error).message}`, 'danger');
    } finally {
      saveInFlight.current = false;
      setSaving(false);
      if (savePending.current || editVersion.current !== version) {
        savePending.current = false;
        scheduleSave(120);
      }
    }
  }
  const mutate = (change: (next: RawConfig) => void) => {
    const next = structuredClone(draft) as RawConfig;
    change(next);
    latestDraft.current = next;
    editVersion.current += 1;
    setDraft(next);
    setDirty(true);
    setStatus('');
    scheduleSave();
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

  const models = draft.models?.entries ?? [];
  const credentials = Object.entries(draft.credentials ?? {});
  const credentialIds = credentials.map(([id]) => id);
  const configuredPlans = plans.filter(plan => plan.configured);
  const planById = new Map(plans.map(plan => [plan.id, plan]));
  const subscriptionModels = (plan: SubscriptionPlan | undefined) => plan?.models.filter(model => model.supported) ?? [];
  const credentialIdForPlan = (plan: SubscriptionPlan) => {
    if (plan.credential?.id && credentialIds.includes(plan.credential.id)) return plan.credential.id;
    if (plan.credential?.secretRef) {
      const matched = credentials.find(([, credential]) => credential.secretRef === plan.credential?.secretRef);
      if (matched) return matched[0];
    }
    return credentialIds.includes(plan.id) ? plan.id : plan.credential?.id ?? plan.id;
  };
  const applySubscription = (index: number, planId: string, modelId?: string) => {
    const plan = planById.get(planId);
    if (!plan) return;
    const model = subscriptionModels(plan).find(item => item.id === modelId) ?? subscriptionModels(plan)[0];
    mutate(next => {
      const entry = next.models!.entries[index]!;
      if (!model) {
        entry.provider = plan.id;
        entry.credentialId = credentialIdForPlan(plan);
        return;
      }
      const replacement = modelFromSubscription(plan, model, next.models!.entries, index);
      replacement.grade = entry.grade;
      if (replacement.reasoning && entry.defaultThinkingLevel && entry.defaultThinkingLevel !== 'off') {
        replacement.defaultThinkingLevel = entry.defaultThinkingLevel;
      }
      next.models!.entries[index] = replacement;
    });
  };
  const addSubscriptionModel = () => {
    const plan = configuredPlans[0] ?? plans[0];
    const model = subscriptionModels(plan)[0];
    mutate(next => {
      const entries = next.models?.entries ?? [];
      const entry = plan && model
        ? modelFromSubscription(plan, model, entries)
        : { ...emptyModel(), credentialId: credentialIds[0] ?? '' };
      next.models = { entries: [...entries, entry] };
    });
  };
  const invalid = (field: string) => error?.field === field ? 'true' : undefined;
  const configurationMessages = <>
    {error && <p data-testid="config-error" style={{ color: 'var(--danger)', margin: 0 }}>{error.message}{error.code ? `（${error.code}）` : ''}</p>}
    {status && <p data-testid="config-status" className="muted" style={{ margin: 0 }}>{status}</p>}
    {priceStatus && <p data-testid="pricing-status" className="muted" style={{ margin: 0 }}>{priceStatus}</p>}
    {status.includes('等待生效') && <div data-testid="restart-required" className="hint-card">待生效：当前守护进程仍使用上一份有效绑定；修正配置后可再次保存。</div>}
  </>;

  return (
    <div className="stagger" data-testid="settings-page" data-page={active}>
      {active === 'settings-overview' && (
        <section id="settings-overview" className="settings-section">
          <Card title="设置" icon="settings" subtitle="所有配置都会自动保存并立即生效">
            <div className="chip-row">
              <Pill>已保存 revision <span data-testid="config-revision">{revision}</span></Pill>
              {effectiveRevision !== null && <Pill tone="info">当前运行版本 <span data-testid="effective-revision">{effectiveRevision}</span>{effectiveRevision !== revision ? '（正在同步）' : ''}</Pill>}
              {saving && <Pill tone="info">正在保存…</Pill>}
              {dirty && !saving && <Pill tone="warn">等待自动保存</Pill>}
            </div>
            <div className="settings-config-messages">{configurationMessages}</div>
          </Card>
          <ThemePlaceholder />
        </section>
      )}

      {active !== 'settings-overview' && <div className="settings-inline-messages">{configurationMessages}</div>}

      {active === 'settings-git' && <section id="settings-git" className="settings-section">
      <ProjectGitCard />
      </section>}

      {active === 'settings-models' && <section className="settings-feature">
      <h2>模型连接</h2>
      <div className="settings-feature-stack">
      <section id="settings-credentials" className="settings-section">
      <Card title="凭据引用" icon="link" subtitle="已连接订阅会自动同步到这里；只保存环境变量名，密钥从不进入配置文件、接口响应或页面"
        actions={<Button size="sm" icon="plus" data-testid="credential-add" onClick={() => mutate(next => { next.credentials = { ...(next.credentials ?? {}), 'new-credential': { secretRef: 'GRAPH_NEW_KEY' } }; })}>添加凭据</Button>}>
        {!credentials.length && <p className="muted">尚未配置凭据。</p>}
        {credentials.map(([id, credential], index) => (
          <div className="credential-card" key={id} data-testid={`credential-row-${index}`} data-id={id}>
            <div className="credential-main">
              <Field label="ID"><input className="input" style={{ width: 150 }} data-testid={`credential-${index}-id`} value={id} onChange={event => mutate(next => {
                const record = next.credentials!;
                const value = record[id]!;
                delete record[id];
                record[event.target.value] = value;
              })} /></Field>
              <Field label="环境变量"><input className="input" style={{ width: 250 }} data-testid={`credential-${index}-secretRef`} value={credential.secretRef} onChange={event => mutate(next => { next.credentials![id]!.secretRef = event.target.value; })} /></Field>
              <Pill tone={credentialState[id] ? 'success' : 'warn'} testid={`credential-${index}-state`}>{credentialState[id] ? '已配置' : '缺失'}</Pill>
              {bridge && <>
                <input className="input" style={{ width: 180 }} type="password" placeholder="API 密钥" data-testid={`credential-${index}-key`}
                  value={keys[id] ?? ''} onChange={event => setKeys(current => ({ ...current, [id]: event.target.value }))} />
                <Button size="sm" variant="danger" data-testid={`credential-${index}-disable`} title="撤销推送的密钥并禁止该连接新发送"
                  onClick={async () => {
                    try {
                      const result = await bridge.saveSecret(credential.secretRef, null);
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
            <details className="disclosure credential-advanced">
              <summary>高级设置</summary>
              <p className="field-hint">共享组用于把多个指向同一上游账号的凭据合并计算并发；每个订阅只出现一次时留空即可。</p>
              <Field label="共享组"><input className="input" style={{ width: 180 }} data-testid={`credential-${index}-group`} value={credential.sharedLimitGroupId ?? ''} placeholder="可选" onChange={event => mutate(next => {
                const value = next.credentials![id]!;
                if (event.target.value) value.sharedLimitGroupId = event.target.value;
                else delete value.sharedLimitGroupId;
              })} /></Field>
            </details>
          </div>
        ))}
      </Card>
      </section>

      <section id="settings-models" className="settings-section">
      <Card title="模型" icon="bolt" subtitle="选择已连接订阅和模型即可；端点、上下文、输出上限与价格会自动填写并可在高级设置中调整"
        actions={<>
          <Button size="sm" icon="refresh" data-testid="pricing-refresh" disabled={refreshing} onClick={() => void refreshPrices()}>{refreshing ? '刷新中…' : '刷新价格快照'}</Button>
          <Button size="sm" icon="plus" data-testid="model-add" disabled={plansLoading} onClick={addSubscriptionModel}>快速添加模型</Button>
        </>}>
        <p data-testid="test-connection-note" className="faint">连通性测试使用当前运行版本的绑定（effective revision），不读取未生效的保存内容。</p>
        <div className="subscription-strip" data-testid="subscription-sync">
          {plansLoading && <span className="muted">正在读取订阅模型…</span>}
          {!plansLoading && configuredPlans.map(plan => <Pill key={plan.id} tone="success">{plan.name} · {plan.models.filter(model => model.supported).length} 个模型</Pill>)}
          {!plansLoading && !configuredPlans.length && <span className="muted">还没有已连接的订阅，可在“用量”中完成连接，或继续使用下方向导。</span>}
          {plansError && <span className="field-error">读取订阅模型失败：{plansError}</span>}
        </div>
        {!models.length && <p className="muted">尚未配置模型。</p>}
        {models.map((model, index) => {
          const selectedPlan = planById.get(model.provider);
          const availableModels = subscriptionModels(selectedPlan);
          const selectedModelId = model.modelId ?? model.id;
          const currentModelMissing = selectedModelId && !availableModels.some(item => item.id === selectedModelId);
          return (
          <div className="model-card" key={index} data-testid={`model-row-${index}`}>
            <div className="card-body">
              <div className="model-quick-grid">
                <Field label="订阅方式">
                  <select className="select" data-testid={`model-${index}-provider`} value={model.provider} onChange={event => applySubscription(index, event.target.value)}>
                    {!planById.has(model.provider) && <option value={model.provider}>{model.provider}（手动配置）</option>}
                    {plans.map(plan => <option key={plan.id} value={plan.id}>{plan.name}{plan.configured ? '' : '（未连接）'}</option>)}
                  </select>
                </Field>
                <Field label="模型">
                  <select className="select" data-testid={`model-${index}-modelId`} value={selectedModelId} onChange={event => applySubscription(index, model.provider, event.target.value)} disabled={!availableModels.length}>
                    {currentModelMissing && <option value={selectedModelId}>{selectedModelId}</option>}
                    {availableModels.map(item => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}
                  </select>
                </Field>
                <Field label="等级">
                  <select className="select" style={{ width: 110 }} data-testid={`model-${index}-grade`} value={model.grade} onChange={event => mutate(next => { next.models!.entries[index]!.grade = event.target.value; })}>
                    {GRADES.map(grade => <option key={grade} value={grade}>{grade}</option>)}
                  </select>
                </Field>
                <Field label="默认思考强度">
                  <select className="select" data-testid={`model-${index}-thinking`} value={model.defaultThinkingLevel ?? (model.reasoning === false ? 'off' : 'medium')} disabled={model.reasoning === false} onChange={event => mutate(next => { next.models!.entries[index]!.defaultThinkingLevel = event.target.value as ModelThinkingLevel; })}>
                    {THINKING_LEVELS.map(level => <option key={level} value={level}>{level}</option>)}
                  </select>
                </Field>
                <Pill tone={model.cost ? 'info' : 'warn'} testid={`model-${index}-price`}>{model.cost ? `价格 输入 ${model.cost.input}/输出 ${model.cost.output} 每百万` : '价格未知（未配置，不会按 0 计算）'}</Pill>
              </div>
              <details className="disclosure model-advanced">
                <summary>高级设置</summary>
                <div className="row">
                  <Field label="配置 ID"><input className="input" style={{ width: 180 }} data-invalid={invalid(`models.entries[${index}].id`)} data-testid={`model-${index}-id`} value={model.id} onChange={event => mutate(next => { next.models!.entries[index]!.id = event.target.value; })} /></Field>
                  <Field label="上游模型 ID"><input className="input" style={{ width: 220 }} data-testid={`model-${index}-upstream-id`} value={model.modelId ?? ''} placeholder="默认与配置 ID 相同" onChange={event => mutate(next => {
                    const entry = next.models!.entries[index]!;
                    if (event.target.value.trim()) entry.modelId = event.target.value;
                    else delete entry.modelId;
                  })} /></Field>
                  <Field label="Provider"><input className="input" style={{ width: 140 }} data-testid={`model-${index}-provider-manual`} value={model.provider} onChange={event => mutate(next => { next.models!.entries[index]!.provider = event.target.value; })} /></Field>
                  <Field label="传输">
                    <select className="select" data-testid={`model-${index}-api`} value={model.api} onChange={event => mutate(next => { next.models!.entries[index]!.api = event.target.value as RawModel['api']; })}>
                      <option value="openai-completions">OpenAI Chat Completions</option>
                      <option value="anthropic-messages">Anthropic Messages</option>
                    </select>
                  </Field>
                  <Field label="凭据">
                    <select className="select" data-invalid={invalid(`models.entries[${index}].credentialId`)} data-testid={`model-${index}-credentialId`} value={model.credentialId} onChange={event => mutate(next => { next.models!.entries[index]!.credentialId = event.target.value; })}>
                      {!credentialIds.includes(model.credentialId) && <option value={model.credentialId}>{model.credentialId || '（未选择）'}</option>}
                      {credentialIds.map(id => <option key={id} value={id}>{id}（{credentialState[id] ? '已配置' : '缺失'}）</option>)}
                    </select>
                  </Field>
                </div>
                <div className="row">
                  <Field label="Base URL"><input className="input" style={{ width: 340, maxWidth: 'none' }} data-invalid={invalid(`models.entries[${index}].baseUrl`)} data-testid={`model-${index}-baseUrl`} value={model.baseUrl} onChange={event => mutate(next => { next.models!.entries[index]!.baseUrl = event.target.value; })} /></Field>
                  <Field label="上下文"><input className="input" style={{ width: 110 }} type="number" data-testid={`model-${index}-context`} value={model.contextWindow} onChange={event => mutate(next => { next.models!.entries[index]!.contextWindow = Number(event.target.value); })} /></Field>
                  <Field label="最大输出"><input className="input" style={{ width: 110 }} type="number" data-testid={`model-${index}-maxTokens`} value={model.maxTokens} onChange={event => mutate(next => { next.models!.entries[index]!.maxTokens = Number(event.target.value); })} /></Field>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      data-testid={`model-${index}-reasoning`}
                      checked={model.reasoning !== false}
                      onChange={event => mutate(next => { next.models!.entries[index]!.reasoning = event.target.checked; })}
                    />
                    <span>可思考模型</span>
                  </label>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      data-testid={`model-${index}-images`}
                      checked={(model.input ?? ['text']).includes('image')}
                      onChange={event => mutate(next => {
                        next.models!.entries[index]!.input = event.target.checked ? ['text', 'image'] : ['text'];
                      })}
                    />
                    <span>支持图片输入</span>
                  </label>
                </div>
                <div className="row">
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
                  <Field label="币种"><input className="input" style={{ width: 90 }} placeholder="USD" data-testid={`model-${index}-cost-currency`} value={model.pricing?.currency ?? ''} onChange={event => mutate(next => {
                    const entry = next.models!.entries[index]!;
                    const currency = event.target.value.trim().toUpperCase();
                    if (!currency) { delete entry.pricing; return; }
                    entry.pricing = { currency, unit: 'per_million_tokens', status: 'known', sourceUrl: 'manual' };
                  })} /></Field>
                  {model.headers && Object.keys(model.headers).length > 0 && (
                    <span className="faint" data-testid={`model-${index}-headers`}>请求头 {Object.entries(model.headers).map(([name, value]) => `${name}=${value}`).join(' · ')}</span>
                  )}
                </div>
              </details>
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
          );
        })}
      </Card>
      </section>
      </div>
      </section>}

      {active === 'settings-models' && <section className="settings-feature">
      <h2>连接与配置向导</h2>
      <Setup onSaved={() => void load()} />
      </section>}

      {active === 'settings-models' && <section className="settings-feature">
      <h2>并发控制</h2>
      <section id="settings-limits" className="settings-section">
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
      </section>
      </section>}

    </div>
  );
}
