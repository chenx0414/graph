import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { usePreferences } from './preferences.ts';
import { Setup } from './Setup.tsx';
import { Button, Card, Field, Icon, Pill, Spinner, toast } from './ui.tsx';
import { STANDARD_ACCESS } from './access-presets.ts';
import type { AccessPolicy } from '../core/access-policy.ts';
import type { ModelInput } from '../catalog/models.ts';
import {
  applyMetadata,
  decodeVendorRef,
  draftFromPlatform,
  encodeVendorRef,
  mergeDiscoveredModels,
  platformOption,
  providerLabelFor,
  readConcurrency,
  validateProviderFormDraft,
  writeConcurrency,
  type ConcurrencyDraft,
  type CredentialDocument,
  type LimitsDocument,
  type ModelDraft,
  type ModelMetadataLike,
  type PlatformOption,
  type ProviderFormDraft,
} from './provider-form.ts';

type Cost = { input: number; output: number; cacheRead: number; cacheWrite: number };
type ModelThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const THINKING_LEVELS: ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
type RawModel = {
  id: string; provider: string; modelId?: string; name?: string; grade: string; api: 'openai-completions' | 'anthropic-messages'; baseUrl: string;
  contextWindow?: number; maxTokens?: number; reasoning?: boolean; defaultThinkingLevel?: ModelThinkingLevel; credentialId: string; cost?: Cost;
  input?: ModelInput[];
  thinkingLevels?: ModelThinkingLevel[];
  pricing?: { currency: string; unit: 'per_million_tokens'; status: 'known' | 'stale' | 'unknown'; sourceUrl?: string; retrievedAt?: string; catalogRevision?: string };
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
type ProviderProbeResponse = {
  models?: { id: string; name?: string; metadata?: unknown }[];
  modelList?: { supported: boolean; error?: string };
  verification: { ok: boolean; error?: string; status?: number; model?: string };
  metadata?: unknown;
};
type ApiError = Error & { code?: string; field?: string };

const GRADES = ['low', 'medium', 'high', 'highest'];

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
    credentials[provider] = { secretRef, displayName: provider };
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

/** Sidebar sections and their fixed order (B-0). Plain data so the console
 * tests can assert navigation without rendering the page. */
export interface SettingsSection {
  id: string;
  label: string;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: 'settings-general', label: '通用/偏好' },
  { id: 'settings-overview', label: '常规' },
  { id: 'settings-models', label: '模型' },
  { id: 'settings-advanced', label: '高级设置' },
  { id: 'settings-git', label: 'Git 准备' },
  { id: 'settings-archived', label: '归档对话' },
];

/** One collapsible region inside the 高级设置 page. `fields` names the config
 * document paths it edits and `testIds` the controls that must keep working. */
export interface AdvancedSetting {
  id: string;
  title: string;
  summary: string;
  fields: readonly string[];
  testIds: readonly string[];
  /** Advanced regions start closed so the common path stays uncluttered. */
  defaultCollapsed: boolean;
}

export const ADVANCED_SETTINGS: readonly AdvancedSetting[] = [];

export const ADVANCED_SETTING_IDS: readonly string[] = ADVANCED_SETTINGS.map(setting => setting.id);

/** Initial open-state for the collapsible advanced regions. Collapsed entries
 * are omitted, so the default map is empty and every region renders closed. */
export function defaultAdvancedOpen(settings: readonly AdvancedSetting[] = ADVANCED_SETTINGS): Record<string, boolean> {
  const open: Record<string, boolean> = {};
  for (const setting of settings) if (!setting.defaultCollapsed) open[setting.id] = true;
  return open;
}

/** Read helper for the controlled collapse, shared with the pure test. */
export function isAdvancedOpen(open: Record<string, boolean>, id: string): boolean {
  return Boolean(open[id]);
}

export function Settings({ openGuide = false }: { openGuide?: boolean } = {}) {
  const [active, setActive] = useState(openGuide ? 'settings-models' : 'settings-overview');
  const [search, setSearch] = useState('');
  useEffect(() => {
    setActive(openGuide ? 'settings-models' : 'settings-overview');
  }, [openGuide]);
  const sections = SETTINGS_SECTIONS;
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
  // B-1 provider wizard state: platform directory, per-vendor step-1 drafts,
  // probe results, model selection and manual model ids.
  const [platforms, setPlatforms] = useState<PlatformOption[]>([]);
  const [providerDrafts, setProviderDrafts] = useState<Record<string, ProviderFormDraft>>({});
  const [providerResults, setProviderResults] = useState<Record<string, ProviderProbeResponse>>({});
  const [providerSelection, setProviderSelection] = useState<Record<string, Record<string, boolean>>>({});
  const [manualModel, setManualModel] = useState<Record<string, string>>({});
  const [providerBusy, setProviderBusy] = useState('');
  // Controlled collapse for the 高级设置 regions; empty means all closed.
  const [advancedOpen, setAdvancedOpen] = useState<Record<string, boolean>>(defaultAdvancedOpen);
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
    void api<{ platforms: PlatformOption[] }>('/api/providers').then(result => {
      if (!cancelled) setPlatforms(result.platforms);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [active]);
  // Step-1 drafts start from the platform defaults and any already-saved model
  // of that credential, but are then owned by the local state.
  useEffect(() => {
    if (!draft || !platforms.length) return;
    setProviderDrafts(current => {
      const next = { ...current };
      const known = platforms.map(option => option.platformId);
      for (const [id, credential] of Object.entries(draft.credentials ?? {})) {
        if (next[id]) continue;
        const decoded = decodeVendorRef(credential.displayName, known);
        const platform = platformOption(platforms, decoded.platformId) ?? platformOption(platforms, 'custom');
        const model = (draft.models?.entries ?? []).find(entry => entry.credentialId === id);
        next[id] = {
          platformId: decoded.platformId,
          name: decoded.platformId === 'custom' ? (decoded.name || '自定义厂商') : platform?.label ?? decoded.name,
          api: model?.api ?? platform?.api ?? 'openai-completions',
          baseUrl: model?.baseUrl ?? platform?.baseUrl ?? '',
          secretRef: credential.secretRef,
        };
      }
      return next;
    });
  }, [draft, platforms]);
  useEffect(() => () => {
    clearTimeout(saveTimer.current);
    if (editVersion.current > 0) void persistDraft(editVersion.current);
  }, []);
  useEffect(() => { void api<Startup>('/api/startup').then(startup => setEffectiveRevision(startup.effectiveRevision ?? null)).catch(() => undefined); }, []);

  const configurationPage = ['settings-overview', 'settings-git', 'settings-models', 'settings-advanced'].includes(active);
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

  // ---- B-1 two-step provider wizard (pure logic lives in provider-form.ts) ----
  const platformIds = platforms.map(option => option.platformId);
  const vendorViews = credentials.map(([id, credential], index) => {
    const decoded = decodeVendorRef(credential.displayName, platformIds);
    const platform = platformOption(platforms, decoded.platformId) ?? platformOption(platforms, 'custom');
    const vendorModels = models.filter(entry => entry.credentialId === id);
    const providerDraft = providerDrafts[id] ?? {
      platformId: decoded.platformId,
      name: decoded.platformId === 'custom' ? (decoded.name || '自定义厂商') : platform?.label ?? decoded.name,
      api: vendorModels[0]?.api ?? platform?.api ?? 'openai-completions' as const,
      baseUrl: vendorModels[0]?.baseUrl ?? platform?.baseUrl ?? '',
      secretRef: credential.secretRef,
    };
    return { id, credential, index, platform, providerDraft, vendorModels };
  });

  const addVendor = () => {
    const used = new Set(Object.keys(draft.credentials ?? {}));
    let id = 'provider';
    let suffix = 2;
    while (used.has(id)) id = `provider-${suffix++}`;
    const platform = platformOption(platforms, 'custom');
    const secretRef = platform?.secretRef ?? 'GRAPH_CUSTOM_API_KEY';
    mutate(next => {
      next.credentials = { ...(next.credentials ?? {}), [id]: { secretRef, displayName: encodeVendorRef('custom', '新厂商') } };
    });
    setProviderDrafts(current => ({ ...current, [id]: { platformId: 'custom', name: '新厂商', api: 'openai-completions', baseUrl: '', secretRef } }));
  };

  const removeVendor = (id: string) => {
    mutate(next => {
      delete next.credentials![id];
      if (next.models) next.models.entries = next.models.entries.filter(entry => entry.credentialId !== id);
      if (next.limits?.credentials) delete next.limits.credentials[id];
    });
  };

  const storeProviderDraft = (id: string, next: ProviderFormDraft) => {
    setProviderDrafts(current => ({ ...current, [id]: next }));
  };

  const selectPlatform = (id: string, platformId: string) => {
    const platform = platformOption(platforms, platformId);
    const previous = providerDrafts[id];
    const customName = previous && previous.platformId === 'custom' ? previous.name : '自定义厂商';
    const next: ProviderFormDraft = {
      platformId,
      name: platform && !platform.custom ? platform.label : customName,
      api: platform?.api ?? 'openai-completions',
      baseUrl: platform?.baseUrl ?? '',
      secretRef: platform?.secretRef ?? previous?.secretRef ?? 'GRAPH_CUSTOM_API_KEY',
    };
    storeProviderDraft(id, next);
    mutate(config => {
      const credential = config.credentials![id]!;
      credential.displayName = encodeVendorRef(platformId, next.name);
      credential.secretRef = next.secretRef;
      for (const entry of config.models?.entries ?? []) {
        if (entry.credentialId !== id) continue;
        entry.api = next.api;
        entry.baseUrl = next.baseUrl;
      }
    });
  };

  const updateProviderField = (id: string, field: 'name' | 'baseUrl' | 'api' | 'secretRef', value: string) => {
    const previous = providerDrafts[id];
    if (!previous) return;
    const next: ProviderFormDraft = { ...previous, [field]: value } as ProviderFormDraft;
    storeProviderDraft(id, next);
    mutate(config => {
      const credential = config.credentials![id]!;
      if (field === 'secretRef') credential.secretRef = value;
      if (field === 'name') credential.displayName = encodeVendorRef(next.platformId, next.name);
      for (const entry of config.models?.entries ?? []) {
        if (entry.credentialId !== id) continue;
        if (field === 'baseUrl') entry.baseUrl = value;
        if (field === 'api') entry.api = value as RawModel['api'];
      }
    });
  };

  const saveProviderKey = async (id: string) => {
    if (!bridge) return;
    const credential = draft.credentials?.[id];
    const value = (keys[id] ?? '').trim();
    if (!credential || !value) return;
    try {
      const stored = await bridge.saveSecret(credential.secretRef, value);
      if (stored?.stored) {
        setCredentialState(current => ({ ...current, [id]: true }));
        setKeys(current => ({ ...current, [id]: '' }));
        toast('密钥已写入系统钥匙串，正在验证…', 'success');
        // Saving the key is the one-click configure step: verify immediately.
        void probeProvider(id);
      } else {
        toast(`密钥保存失败：${stored?.message ?? '钥匙串不可用'}`, 'danger');
      }
    } catch (reason) {
      toast(`密钥保存失败：${(reason as Error).message}`, 'danger');
    }
  };

  const disableProviderKey = async (id: string) => {
    if (!bridge) return;
    const credential = draft.credentials?.[id];
    if (!credential) return;
    try {
      const result = await bridge.saveSecret(credential.secretRef, null);
      if (!result?.applied) throw new Error(result?.message ?? '撤销未生效');
      setCredentialState(current => ({ ...current, [id]: false }));
      setKeys(current => ({ ...current, [id]: '' }));
      toast('连接已禁用；重新保存密钥即可恢复', 'success');
    } catch (reason) {
      toast(`禁用失败：${(reason as Error).message}`, 'danger');
    }
  };

  const probeProvider = async (id: string, modelId?: string): Promise<ProviderProbeResponse | null> => {
    const providerDraft = providerDrafts[id];
    if (!providerDraft) return null;
    const validation = validateProviderFormDraft(providerDraft, platformOption(platforms, providerDraft.platformId));
    if (!validation.ok) {
      const first = Object.values(validation.errors)[0] ?? '厂商草稿不完整';
      setProviderResults(current => ({ ...current, [id]: { modelList: { supported: false }, verification: { ok: false, error: first } } }));
      toast(`请先补全厂商配置：${first}`, 'danger');
      return null;
    }
    setProviderBusy(id);
    try {
      const result = await api<ProviderProbeResponse>('/api/providers/probe', {
        method: 'POST',
        body: JSON.stringify({ provider: validation.value, ...(modelId ? { modelId } : {}) }),
      });
      setProviderResults(current => ({ ...current, [id]: result }));
      toast(result.verification.ok ? '厂商验证成功，可继续选择模型' : `厂商验证失败：${result.verification.error ?? '未知原因'}`, result.verification.ok ? 'success' : 'danger');
      return result;
    } catch (reason) {
      const message = (reason as Error).message;
      setProviderResults(current => ({ ...current, [id]: { modelList: { supported: false }, verification: { ok: false, error: message } } }));
      toast(`厂商验证失败：${message}`, 'danger');
      return null;
    } finally {
      setProviderBusy('');
    }
  };

  const toggleModelSelection = (providerId: string, modelId: string, checked: boolean) => {
    setProviderSelection(current => ({ ...current, [providerId]: { ...(current[providerId] ?? {}), [modelId]: checked } }));
  };

  const addModelsFromProbe = (id: string, credentialId: string, only?: { id: string; metadata?: unknown }) => {
    const providerDraft = providerDrafts[id];
    const discovered = only
      ? [{ id: only.id, ...(only.metadata ? { metadata: only.metadata as ModelMetadataLike } : {}) }]
      : (providerResults[id]?.models ?? [])
        .filter(model => providerSelection[id]?.[model.id])
        .map(model => ({ id: model.id, ...(model.name ? { name: model.name } : {}), ...(model.metadata ? { metadata: model.metadata as ModelMetadataLike } : {}) }));
    if (!discovered.length) {
      toast('请先勾选要添加的模型', 'info');
      return;
    }
    mutate(next => {
      const existing = next.models?.entries ?? [];
      const others = existing.filter(entry => entry.credentialId !== credentialId);
      const mine = existing.filter(entry => entry.credentialId === credentialId);
      const merged = mergeDiscoveredModels(mine as unknown as ModelDraft[], discovered, {
        provider: providerLabelFor(providerDraft?.platformId ?? 'custom', credentialId, existing),
        api: providerDraft?.api ?? 'openai-completions',
        baseUrl: providerDraft?.baseUrl ?? '',
        credentialId,
      }, { retrievedAt: new Date().toISOString().slice(0, 10) });
      next.models = { entries: [...others, ...(merged as unknown as RawModel[])] };
    });
    toast(`已添加 ${discovered.length} 个模型`, 'success');
  };

  const addManualModel = async (id: string, credentialId: string) => {
    const upstreamId = (manualModel[id] ?? '').trim();
    if (!upstreamId) {
      toast('请输入模型 id', 'info');
      return;
    }
    const result = await probeProvider(id, upstreamId);
    addModelsFromProbe(id, credentialId, { id: upstreamId, ...(result?.metadata ? { metadata: result.metadata } : {}) });
    setManualModel(current => ({ ...current, [id]: '' }));
  };

  const concurrencyOf = (credentialId: string, credential: RawCredential): ConcurrencyDraft =>
    readConcurrency(draft.limits as unknown as LimitsDocument, credential as unknown as CredentialDocument, credentialId);

  const applyConcurrency = (credentialId: string, change: Partial<ConcurrencyDraft>) => {
    const current = concurrencyOf(credentialId, draft.credentials?.[credentialId] ?? { secretRef: '' });
    const next = { ...current, ...change };
    mutate(config => {
      const credential = config.credentials![credentialId]!;
      const written = writeConcurrency(config.limits as unknown as LimitsDocument, credential as unknown as CredentialDocument, credentialId, next);
      config.limits = written.limits as NonNullable<RawConfig['limits']>;
      const merged: RawCredential = { ...credential };
      if (written.credential.sharedLimitGroupId) merged.sharedLimitGroupId = written.credential.sharedLimitGroupId;
      else delete merged.sharedLimitGroupId;
      config.credentials![credentialId] = merged;
    });
  };

  const updateModel = (index: number, change: (entry: RawModel) => void) => {
    mutate(next => {
      const entry = next.models?.entries[index];
      if (entry) change(entry);
    });
  };

  const renderModelRow = (model: RawModel, index: number) => {
    const images = (model.input ?? ['text']).includes('image');
    const thinkingValue = model.defaultThinkingLevel ?? (model.reasoning === false ? 'off' : 'medium');
    return (
      <div className="model-card" key={model.id} data-testid={`model-row-${index}`}>
        <div className="card-body">
          <div className="model-quick-grid">
            <Field label="上游模型 ID"><input className="input" data-testid={`model-${index}-modelId`} value={model.modelId ?? model.id} onChange={event => updateModel(index, entry => {
              if (event.target.value.trim()) entry.modelId = event.target.value;
              else delete entry.modelId;
            })} /></Field>
            <Field label="等级">
              <select className="select" style={{ width: 110 }} data-testid={`model-${index}-grade`} value={model.grade} onChange={event => updateModel(index, entry => { entry.grade = event.target.value; })}>
                {GRADES.map(grade => <option key={grade} value={grade}>{grade}</option>)}
              </select>
            </Field>
            <Field label="默认思考强度">
              <select className="select" data-testid={`model-${index}-thinking`} value={thinkingValue} disabled={model.reasoning === false} onChange={event => updateModel(index, entry => { entry.defaultThinkingLevel = event.target.value as ModelThinkingLevel; })}>
                {THINKING_LEVELS.map(level => <option key={level} value={level}>{level}</option>)}
              </select>
            </Field>
            <Field label="上下文"><input className="input" style={{ width: 110 }} type="number" placeholder="未知" data-testid={`model-${index}-context`} value={model.contextWindow ?? ''} onChange={event => updateModel(index, entry => {
              const value = Number(event.target.value);
              if (event.target.value === '' || !Number.isFinite(value)) delete entry.contextWindow;
              else entry.contextWindow = value;
            })} /></Field>
            <Field label="最大输出"><input className="input" style={{ width: 110 }} type="number" placeholder="未知" data-testid={`model-${index}-maxTokens`} value={model.maxTokens ?? ''} onChange={event => updateModel(index, entry => {
              const value = Number(event.target.value);
              if (event.target.value === '' || !Number.isFinite(value)) delete entry.maxTokens;
              else entry.maxTokens = value;
            })} /></Field>
            <label className="checkbox-row">
              <input type="checkbox" data-testid={`model-${index}-images`} checked={images} onChange={event => updateModel(index, entry => { entry.input = event.target.checked ? ['text', 'image'] : ['text']; })} />
              <span>支持图片输入</span>
            </label>
            <Pill tone={model.cost ? 'info' : 'warn'} testid={`model-${index}-price`}>{model.cost ? `价格 输入 ${model.cost.input} / 输出 ${model.cost.output} 每百万 ${model.pricing?.currency ?? ''}` : '价格未知（不会按 0 计算，可手填）'}</Pill>
          </div>
          <details className="disclosure model-advanced">
            <summary>高级设置</summary>
            <div className="row">
              <Field label="配置 ID"><input className="input" style={{ width: 180 }} data-invalid={invalid(`models.entries[${index}].id`)} data-testid={`model-${index}-id`} value={model.id} onChange={event => updateModel(index, entry => { entry.id = event.target.value; })} /></Field>
              <Field label="传输">
                <select className="select" data-testid={`model-${index}-api`} value={model.api} onChange={event => updateModel(index, entry => { entry.api = event.target.value as RawModel['api']; })}>
                  <option value="openai-completions">OpenAI Chat Completions</option>
                  <option value="anthropic-messages">Anthropic Messages</option>
                </select>
              </Field>
              <Field label="凭据">
                <select className="select" data-invalid={invalid(`models.entries[${index}].credentialId`)} data-testid={`model-${index}-credentialId`} value={model.credentialId} onChange={event => updateModel(index, entry => { entry.credentialId = event.target.value; })}>
                  {!credentialIds.includes(model.credentialId) && <option value={model.credentialId}>{model.credentialId || '（未选择）'}</option>}
                  {credentialIds.map(id => <option key={id} value={id}>{id}（{credentialState[id] ? '已配置' : '缺失'}）</option>)}
                </select>
              </Field>
              <Field label="Provider"><input className="input" style={{ width: 140 }} data-testid={`model-${index}-provider-manual`} value={model.provider} onChange={event => updateModel(index, entry => { entry.provider = event.target.value; })} /></Field>
            </div>
            <div className="row">
              <Field label="Base URL"><input className="input" style={{ width: 340, maxWidth: 'none' }} data-invalid={invalid(`models.entries[${index}].baseUrl`)} data-testid={`model-${index}-baseUrl`} value={model.baseUrl} onChange={event => updateModel(index, entry => { entry.baseUrl = event.target.value; })} /></Field>
              <label className="checkbox-row">
                <input type="checkbox" data-testid={`model-${index}-reasoning`} checked={model.reasoning !== false} onChange={event => updateModel(index, entry => { entry.reasoning = event.target.checked; })} />
                <span>可思考模型</span>
              </label>
            </div>
            <div className="row">
              <Field label="输入价/百万"><input className="input" style={{ width: 110 }} type="number" placeholder="未知" data-testid={`model-${index}-input-cost`} value={model.cost?.input ?? ''} onChange={event => updateModel(index, entry => {
                const value = Number(event.target.value);
                if (event.target.value === '' || !Number.isFinite(value)) { delete entry.cost; return; }
                entry.cost = { input: value, output: entry.cost?.output ?? 0, cacheRead: entry.cost?.cacheRead ?? 0, cacheWrite: entry.cost?.cacheWrite ?? 0 };
                entry.pricing = { currency: entry.pricing?.currency ?? 'USD', unit: 'per_million_tokens', status: 'known', ...(entry.pricing?.sourceUrl ? { sourceUrl: entry.pricing.sourceUrl } : {}) };
              })} /></Field>
              <Field label="输出价/百万"><input className="input" style={{ width: 110 }} type="number" placeholder="未知" data-testid={`model-${index}-output-cost`} value={model.cost?.output ?? ''} onChange={event => updateModel(index, entry => {
                const value = Number(event.target.value);
                if (event.target.value === '' || !Number.isFinite(value)) { delete entry.cost; return; }
                entry.cost = { input: entry.cost?.input ?? 0, output: value, cacheRead: entry.cost?.cacheRead ?? 0, cacheWrite: entry.cost?.cacheWrite ?? 0 };
                entry.pricing = { currency: entry.pricing?.currency ?? 'USD', unit: 'per_million_tokens', status: 'known', ...(entry.pricing?.sourceUrl ? { sourceUrl: entry.pricing.sourceUrl } : {}) };
              })} /></Field>
              <Field label="币种"><input className="input" style={{ width: 90 }} placeholder="USD" data-testid={`model-${index}-cost-currency`} value={model.pricing?.currency ?? ''} onChange={event => updateModel(index, entry => {
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

      {active === 'settings-models' && <section id="settings-models" className="settings-feature">
      <h2>模型与厂商</h2>
      <p className="muted" data-testid="provider-steps-note">两步流程：先「配置厂商」——填 API KEY / 订阅凭据并一键验证；再在该厂商内「选择模型」——从可用列表挑选或手动添加 id，元数据自动填充。</p>
      <div className="settings-feature-stack">
      <section id="settings-credentials" className="settings-section">
      <Card title="第一步 · 配置厂商" icon="link"
        subtitle="已支持厂商只需填 API KEY 或订阅凭据；自定义厂商需填厂商名、Base URL 与兼容格式。密钥只写入钥匙串或环境变量名，页面与接口都不回传明文。"
        actions={<Button size="sm" icon="plus" data-testid="credential-add" onClick={addVendor}>添加厂商</Button>}>
        {!vendorViews.length && <p className="muted">尚未配置厂商。</p>}
        {vendorViews.map(vendor => {
          const concurrency = concurrencyOf(vendor.id, vendor.credential);
          const result = providerResults[vendor.id];
          const discovered = result?.models ?? [];
          return (
          <div className="provider-card" key={vendor.id} data-testid={`provider-card-${vendor.index}`} data-id={vendor.id}>
            <div className="provider-card-head">
              <Pill tone={credentialState[vendor.id] ? 'success' : 'warn'} testid={`credential-${vendor.index}-state`}>{credentialState[vendor.id] ? '凭据已配置' : '凭据缺失'}</Pill>
              <strong data-testid={`credential-${vendor.index}-name-label`}>{vendor.providerDraft.name}</strong>
              <span className="muted">{vendor.id} · {vendor.platform?.credentialLabel ?? '自定义凭据'}</span>
              <div className="topbar-spacer" />
              <Button size="sm" variant="danger" data-testid={`provider-${vendor.index}-remove`} onClick={() => removeVendor(vendor.id)}>删除厂商</Button>
            </div>
            <div className="row provider-fields">
              <Field label="厂商平台">
                <select className="select" data-testid={`credential-${vendor.index}-platform`} value={vendor.providerDraft.platformId} onChange={event => selectPlatform(vendor.id, event.target.value)}>
                  {platforms.map(option => <option key={option.platformId} value={option.platformId}>{option.label}</option>)}
                </select>
              </Field>
              {vendor.providerDraft.platformId === 'custom' && (
                <Field label="厂商名"><input className="input" style={{ width: 160 }} data-testid={`credential-${vendor.index}-name`} value={vendor.providerDraft.name} onChange={event => updateProviderField(vendor.id, 'name', event.target.value)} /></Field>
              )}
              <Field label="Base URL"><input className="input" style={{ width: 320, maxWidth: 'none' }} data-testid={`credential-${vendor.index}-baseUrl`} value={vendor.providerDraft.baseUrl} placeholder="https://…" onChange={event => updateProviderField(vendor.id, 'baseUrl', event.target.value)} /></Field>
              <Field label="兼容格式">
                <select className="select" data-testid={`credential-${vendor.index}-api`} value={vendor.providerDraft.api} onChange={event => updateProviderField(vendor.id, 'api', event.target.value)}>
                  <option value="openai-completions">OpenAI Chat Completions</option>
                  <option value="anthropic-messages">Anthropic Messages</option>
                </select>
              </Field>
              <Field label="凭据环境变量"><input className="input" style={{ width: 250 }} data-testid={`credential-${vendor.index}-secretRef`} value={vendor.providerDraft.secretRef} onChange={event => updateProviderField(vendor.id, 'secretRef', event.target.value)} /></Field>
              {bridge && <>
                <input className="input" style={{ width: 180 }} type="password" placeholder="API 密钥" data-testid={`credential-${vendor.index}-key`}
                  value={keys[vendor.id] ?? ''} onChange={event => setKeys(current => ({ ...current, [vendor.id]: event.target.value }))} />
                <Button size="sm" icon="link" data-testid={`credential-${vendor.index}-key-save`} disabled={!(keys[vendor.id] ?? '').trim()} onClick={() => void saveProviderKey(vendor.id)}>保存到钥匙串</Button>
                <Button size="sm" variant="danger" data-testid={`credential-${vendor.index}-disable`} title="撤销推送的密钥并禁止该连接新发送" onClick={() => void disableProviderKey(vendor.id)}>禁用连接</Button>
              </>}
            </div>
            {vendor.platform && <p className="field-hint" data-testid={`credential-${vendor.index}-hint`}>{vendor.platform.notes.join(' ')}{vendor.platform.supportsModelList ? '' : '（该平台不提供模型列表，请手动添加模型 id）'}</p>}
            <div className="row">
              <Button size="sm" icon="bolt" data-testid={`provider-${vendor.index}-verify`} disabled={providerBusy === vendor.id} onClick={() => void probeProvider(vendor.id)}>{providerBusy === vendor.id ? '验证中…' : '保存并验证'}</Button>
              {result && <span data-testid={`provider-${vendor.index}-result`} className={result.verification.ok ? 'muted' : 'field-error'}>
                {result.verification.ok ? `验证通过${result.verification.status ? `（HTTP ${result.verification.status}）` : ''}` : `验证失败：${result.verification.error ?? '未知原因'}`}
              </span>}
            </div>
            <div className="provider-concurrency" data-testid={`provider-${vendor.index}-concurrency`}>
              <p className="field-hint">并发控制（保存后立即对新请求生效；已有调用保留计数，不会中断在途请求）</p>
              <div className="row">
                <Field label="该凭据上限"><input className="input" style={{ width: 100 }} type="number" placeholder="运行时默认" data-testid={`limit-credential-${vendor.index}`} value={concurrency.credentialLimit ?? ''} onChange={event => {
                  const value = Number(event.target.value);
                  applyConcurrency(vendor.id, event.target.value === '' || !Number.isFinite(value) ? { credentialLimit: 0 } : { credentialLimit: value });
                }} /></Field>
                <Field label="共享组"><input className="input" style={{ width: 160 }} placeholder="可选" data-testid={`credential-${vendor.index}-group`} value={concurrency.sharedGroupId ?? ''} onChange={event => applyConcurrency(vendor.id, { sharedGroupId: event.target.value })} /></Field>
                <Field label="共享组上限"><input className="input" style={{ width: 100 }} type="number" placeholder="运行时默认" data-testid={`limit-group-${vendor.index}`} value={concurrency.sharedGroupLimit ?? ''} onChange={event => {
                  const value = Number(event.target.value);
                  applyConcurrency(vendor.id, event.target.value === '' || !Number.isFinite(value) ? { sharedGroupLimit: 0 } : { sharedGroupLimit: value });
                }} /></Field>
              </div>
            </div>
            <div className="provider-step-two">
              <h4>第二步 · 选择模型</h4>
              <div className="row">
                <Button size="sm" icon="refresh" data-testid={`provider-${vendor.index}-fetch`} disabled={providerBusy === vendor.id} onClick={() => void probeProvider(vendor.id)}>{providerBusy === vendor.id ? '获取中…' : '获取可用模型'}</Button>
                <input className="input" style={{ width: 220 }} placeholder="手动添加模型 id" data-testid={`provider-${vendor.index}-manual`} value={manualModel[vendor.id] ?? ''} onChange={event => setManualModel(current => ({ ...current, [vendor.id]: event.target.value }))} />
                <Button size="sm" icon="plus" data-testid={`provider-${vendor.index}-manual-add`} onClick={() => void addManualModel(vendor.id, vendor.id)}>添加</Button>
                {discovered.length > 0 && <Button size="sm" data-testid={`provider-${vendor.index}-add-selected`} onClick={() => addModelsFromProbe(vendor.id, vendor.id)}>添加所选模型</Button>}
              </div>
              {result?.modelList && !result.modelList.supported && <p className="muted" data-testid={`provider-${vendor.index}-list-unsupported`}>该端点不支持模型列表，请手动添加模型 id。</p>}
              {result?.modelList?.error && <p className="field-error" data-testid={`provider-${vendor.index}-list-error`}>{result.modelList.error}</p>}
              {discovered.length > 0 && <div className="provider-model-list" data-testid={`provider-${vendor.index}-model-list`}>
                {discovered.map(model => (
                  <label className="checkbox-row" key={model.id}>
                    <input type="checkbox" data-testid={`provider-${vendor.index}-model-${model.id}`} checked={providerSelection[vendor.id]?.[model.id] ?? false} onChange={event => toggleModelSelection(vendor.id, model.id, event.target.checked)} />
                    <span>{model.name ?? model.id} <span className="muted">{model.id}</span>{model.metadata ? ' · 元数据已匹配' : ' · 元数据未知'}</span>
                  </label>
                ))}
              </div>}
              {!vendor.vendorModels.length && <p className="muted" data-testid={`provider-${vendor.index}-no-models`}>该厂商还没有模型，先从上方列表挑选或手动添加一个。</p>}
              {vendor.vendorModels.map(model => renderModelRow(model, models.indexOf(model)))}
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

      {active === 'settings-advanced' && <section className="settings-feature">
      <h2>高级设置</h2>
      <p className="muted">并发上限（每凭据与跨凭据共享组）已并入「模型」页的厂商配置，保存后立即生效；这里不再有独立的并发限制分区。</p>
      <section id="settings-advanced" className="settings-section settings-advanced-list">
        {!ADVANCED_SETTINGS.length && <p className="muted" data-testid="advanced-empty">暂时没有独立的高级选项。</p>}
      </section>
      </section>}

    </div>
  );
}
