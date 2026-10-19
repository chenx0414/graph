import { ProviderLogin } from './ProviderLogin.tsx';
import { ProviderPicker, ProviderIcon } from './ProviderPicker.tsx';
import { ModelGradeOptions } from './model-grade-options.tsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { usePreferences } from './preferences.ts';
import { Setup } from './Setup.tsx';
import { Button, Card, Field, Icon, Pill, Spinner, toast } from './ui.tsx';
import { standardAccessPolicy } from '../core/access-policy-presets.ts';
import type { AccessPolicy } from '../core/access-policy.ts';
import { MODEL_TIERS, MODEL_GRADES, modelTier, modelRequestHeaders, type ModelGrade, type ModelTier, type ModelInput } from '../catalog/models.ts';
import { defaultThinkingLevelFor } from '../catalog/models.ts';
import { nearestLevel, thinkingOptionLabel } from './thinking-levels.ts';
import {
  FALLBACK_PLATFORMS,
  PROVIDER_COMPATIBILITIES,
  autoProbeDecision,
  buildEntryDraft,
  completeCost,
  concurrencyControlIds,
  customDraft,
  draftFromModelVendor,
  draftFromPlatform,
  accountCredentialEntry,
  draftForCredential,
  draftFromPlatformWithCredential,
  nextAccountDraft,
  draftToModelEntry,
  hasProviderErrors,
  hasRequiredModelFields,
  isCustomPlatform,
  keyEntryGuidance,
  mergeProbeModels,
  metadataToFields,
  missingRequiredModelFields,
  modelFieldErrors,
  modelVendorsFrom,
  normalizePlatforms,
  platformById,
  platformsRequest,
  probeFailureNote,
  probeRequest,
  readConcurrency,
  selectedProbeModels,
  thinkingOptionsFromMetadata,
  uniqueLocalModelId,
  validateProviderDraft,
  withCostField,
  writeConcurrency,
  type ConcurrencyDraft,
  type ModelCostDraft,
  type ModelPick,
  type PlatformPreset,
  type ProbeModel,
  type ProviderDraft,
  type ProviderDraftErrors,
  type SnapshotMetadata,
} from './provider-form.ts';
import type { DesktopBridge } from './setup.ts';

// Lane one owns the vendored models.dev snapshot mapping. It is imported
// lazily so this settings lane still typechecks and loads before that module is
// merged; a missing mapping simply means metadata stays unknown and the user
// fills the fields by hand.
type ModelsDevModule = { lookupModelMetadata: (...args: any[]) => SnapshotMetadata | null | undefined };
let modelsDevModule: Promise<ModelsDevModule> | null = null;
function loadModelsDev(): Promise<ModelsDevModule> {
  // @ts-ignore -- module added by the impl-catalog-snapshot lane
  return import('../catalog/models-dev.ts');
}

type ModelThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
type RawModel = {
  id: string; provider: string; modelId?: string; grade?: string; api: 'openai-completions' | 'anthropic-messages'; baseUrl: string;
  contextWindow?: number; maxTokens?: number; reasoning?: boolean; defaultThinkingLevel?: ModelThinkingLevel; credentialId: string; cost?: ModelCostDraft;
  /** Per-model strengths the server adds to the view; stripped before saving. */
  tier?: ModelTier;
  thinkingOptions?: { level: string; label: string }[];
  input?: ModelInput[];
  pricing?: { currency: string; unit: 'per_million_tokens'; status: 'known' | 'stale' | 'unknown'; sourceUrl?: string; retrievedAt?: string; catalogRevision?: string };
  headers?: Record<string, string>;
};
type RawCredential = { secretRef: string; displayName?: string; sharedLimitGroupId?: string; platform?: string };
type RawConfig = {
  version: 1;
  projects?: { id: string; root: string; grants?: string[] }[];
  models?: { entries: RawModel[]; preferences?: Partial<Record<ModelGrade, string[]>> };
  credentials?: Record<string, RawCredential>;
  limits?: { credentials?: Record<string, number>; sharedGroups?: Record<string, number> };
  access?: AccessPolicy;
};
type ConfigResponse = { revision: number; effectiveRevision?: number; config: RawConfig & { path: string | null; credentials?: Record<string, RawCredential & { configured?: boolean }> } };
type Startup = {
  effectiveRevision?: number;
  /**
   * The code the daemon is running. The console shows it because "committed" and "live" are
   * different facts: a change lands in a checkout, and only a reload makes the daemon run it.
   */
  source?: { root: string; commit: string | null; branch: string | null; dirty: boolean | null };
};
type ApiError = Error & { code?: string; field?: string };

const GRADES = MODEL_GRADES;
type CcSwitchPrice = {
  modelId: string;
  displayName: string;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  cacheReadCostPerMillion: number;
  cacheCreationCostPerMillion: number;
};
type CcSwitchPricing = { source: string; updatedAt: number | null; models: CcSwitchPrice[] };
let ccSwitchPricingRequest: Promise<CcSwitchPricing> | null = null;

function loadCcSwitchPricing(): Promise<CcSwitchPricing> {
  ccSwitchPricingRequest ??= api<CcSwitchPricing>('/api/model-pricing').catch(() => ({
    source: '~/.cc-switch/model-pricing.json',
    updatedAt: null,
    models: [],
  }));
  return ccSwitchPricingRequest;
}

function findCcSwitchPrice(modelId: string, pricing: CcSwitchPricing): CcSwitchPrice | undefined {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) return undefined;
  const exact = pricing.models.find(model => model.modelId.toLowerCase() === normalized);
  if (exact) return exact;
  const leaf = normalized.split('/').at(-1)!;
  return pricing.models.find(model => model.modelId.toLowerCase() === leaf)
    ?? pricing.models.find(model => normalized.endsWith(model.modelId.toLowerCase()) || model.modelId.toLowerCase().endsWith(normalized));
}

function ccSwitchCost(price: CcSwitchPrice): NonNullable<SnapshotMetadata['cost']> {
  return {
    input: price.inputCostPerMillion,
    output: price.outputCostPerMillion,
    cacheRead: price.cacheReadCostPerMillion,
    cacheWrite: price.cacheCreationCostPerMillion,
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
    ...(config.models ? { models: { ...config.models, entries: config.models.entries } } : {}),
    credentials,
    limits: config.limits ?? {},
    access: config.access ?? standardAccessPolicy(),
  };
}

/** The document the daemon stores: view-only fields the console derives (the
 * per-model thinking strengths) are dropped here, so a save can never write
 * derived data into the configuration file. */
function toDocument(draft: RawConfig): RawConfig {
  if (!draft.models) return draft;
  return {
    ...draft,
    models: { ...draft.models, entries: draft.models.entries.map(({ thinkingOptions: _derived, tier: _tier, ...entry }) => entry) },
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
      toast(result.state === 'ready' ? '项目基线已就绪' : '需要处理未提交修改', result.state === 'ready' ? 'success' : 'info');
    } catch (reason) {
      toast(`准备失败：${reason instanceof Error ? reason.message : String(reason)}`, 'danger');
    } finally {
      setBusy('');
      await load().catch(() => undefined);
    }
  };
  const label = (state: string | undefined) => state === 'ready' ? '已准备' : state === 'detected' ? '待处理' : state === 'failed' ? '失败' : '未准备';
  return (
    <Card title="项目与本地基线" icon="box" subtitle="正式派发前必须准备好 Git 与本地基线；普通目录由宿主初始化并建立本地版本记录">
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
    <section className="settings-section" data-testid="settings-preferences">
      <Card title="偏好" icon="settings" subtitle="保存在本机浏览器，修改后立即生效">
        <div className="preference-list">
          <label className="preference-item">
            <span className="preference-copy">
              <strong>Markdown 渲染</strong>
              <span className="muted">开启后显示输入草稿的实时 Markdown 预览，并渲染你与主 Agent 的消息；关闭后显示原文。</span>
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

/**
 * Which code the daemon is running.
 *
 * The distinction it draws is the one that has cost real time: "saved a config revision" and
 * "running this commit" are different facts, and so are "committed to a checkout" and "loaded by
 * the process". The daemon reads this once at startup, so what is shown here is what it runs, and
 * the copy says plainly that changing source needs a reload to take effect.
 */
function RunningSourceCard({ source }: { source?: { root: string; commit: string | null; branch: string | null; dirty: boolean | null } | undefined }) {
  if (!source) return null;
  const commit = source.commit ? source.commit.slice(0, 12) : '未知';
  return (
    <Card
      title="运行中的代码"
      icon="box"
      subtitle="守护进程启动时载入的那份源码；改动源码后必须重载才会生效"
      testid="running-source"
    >
      <div className="chip-row">
        <Pill tone={source.commit ? 'info' : 'warn'}>
          <span>源码根：</span><span data-testid="source-root">{source.root}</span>
        </Pill>
        <Pill tone={source.commit ? 'info' : 'warn'}>
          <span>提交：</span><span data-testid="source-commit">{commit}</span>
        </Pill>
        {source.branch && <Pill tone="info"><span>分支：</span><span data-testid="source-branch">{source.branch}</span></Pill>}
        {source.dirty === true && <Pill tone="warn" testid="source-dirty">有未提交改动</Pill>}
      </div>
      {!source.commit && (
        <p className="muted" data-testid="source-unknown">
          这份运行代码不在 Git 检出里（打包应用或没有 git），因此没有提交号可显示。
        </p>
      )}
    </Card>
  );
}

function ThemePlaceholder() {
  return (
    <section className="settings-feature" data-testid="theme-placeholder">
      <h2>外观</h2>
      <p className="muted">当前使用浅色主题。深色与跟随系统主题尚未提供。</p>
    </section>
  );
}

function ConfiguredModelsPanel({ draft, credentialState, mutate, onManage, onEdit }: {
  draft: RawConfig;
  credentialState: Record<string, boolean>;
  mutate: (change: (next: RawConfig) => void) => void;
  onManage: (target: 'settings-credentials' | 'settings-models') => void;
  onEdit: (credentialId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [tierFilter, setTierFilter] = useState<ModelTier | ''>('');
  const entries = draft.models?.entries ?? [];
  const available = entries.filter(entry => credentialState[entry.credentialId] && hasRequiredModelFields(entry));
  const defaultId = available[0]?.id;
  const matches = entries.filter(entry => (!tierFilter || (entry.grade && modelTier(entry.grade as ModelGrade) === tierFilter)) && `${entry.id} ${entry.modelId ?? ''} ${entry.provider} ${draft.credentials?.[entry.credentialId]?.displayName ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <Card title={`已配置模型 · ${entries.length}`} icon="bolt" subtitle="所有厂商的模型集中在这里；可搜索、查看连接状态，并选择新对话的默认模型"
      testid="configured-models"
      actions={<div className="row"><Button size="sm" onClick={() => onManage('settings-credentials')}>连接厂商</Button><Button size="sm" onClick={() => onManage('settings-models')}>添加模型</Button></div>}>
      {entries.length === 0 ? (
        <div className="models-empty" data-testid="configured-models-empty">
          <strong>还没有配置模型</strong>
          <span>从下方选择厂商，保存凭据，再选用该厂商的模型。</span>
        </div>
      ) : <>
        <div className="configured-models-summary">
          <Pill tone={available.length ? 'success' : 'warn'}>{available.length} 个凭据就绪</Pill>
          <span>新对话默认：<strong data-testid="configured-default-model">{available[0]?.modelId ?? available[0]?.id ?? '暂无可用模型'}</strong></span>
          <span className="muted">切换默认只影响新对话；已有会话的模型保持原样。</span>
        </div>
        <label className="configured-models-search"><Icon name="search" size={15} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索模型或厂商" aria-label="搜索已配置模型" /></label>
        <label className="row" style={{ marginBottom: 8 }}>模型分层
          <select className="select" aria-label="筛选模型分层" data-testid="model-tier-filter" value={tierFilter} onChange={event => setTierFilter(event.target.value as ModelTier | '')}>
            <option value="">全部</option>{MODEL_TIERS.map(tier => <option key={tier} value={tier}>{tier}</option>)}
          </select>
        </label>
        <div className="configured-models-list">
          {matches.map(entry => {
            const connected = Boolean(credentialState[entry.credentialId]);
            const complete = hasRequiredModelFields(entry);
            const isDefault = entry.id === defaultId;
            return <div className="configured-model-item" key={entry.id} data-testid={`configured-model-${entry.id}`}>
              <div className="configured-model-main"><strong>{entry.modelId ?? entry.id}</strong><span className="muted">{draft.credentials?.[entry.credentialId]?.displayName ?? entry.provider} · {entry.id}</span></div>
              <div className="configured-model-meta">
                <Pill tone={connected && complete ? 'success' : 'warn'}>{!connected ? '凭据缺失' : complete ? '凭据就绪' : '待补全'}</Pill>
                {entry.grade && <Pill>{modelTier(entry.grade as ModelGrade)}</Pill>}
                {isDefault && <Pill tone="info">新对话默认</Pill>}
              </div>
              <div className="configured-model-actions">
                {!isDefault && <Button size="sm" disabled={!connected || !complete} data-testid={`configured-default-${entry.id}`} onClick={() => mutate(next => {
                  const list = next.models?.entries;
                  if (!list) return;
                  const index = list.findIndex(model => model.id === entry.id);
                  if (index > 0) list.unshift(...list.splice(index, 1));
                })}>设为默认</Button>}
                <Button size="sm" data-testid={`configured-edit-${entry.id}`} onClick={() => onEdit(entry.credentialId)}>编辑</Button>
              </div>
            </div>;
          })}
          {matches.length === 0 && <p className="muted">没有匹配的模型。</p>}
        </div>
      </>}
    </Card>
  );
}

function ConfiguredProvidersPanel({ draft, credentialState, onEdit, onDelete }: {
  draft: RawConfig;
  credentialState: Record<string, boolean>;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const credentials = Object.entries(draft.credentials ?? {});
  return <Card title={`已配置厂商 · ${credentials.length}`} icon="link" subtitle="管理已保存的厂商账户及其关联模型" testid="configured-providers">
    {credentials.length === 0 ? <p className="muted">尚未配置厂商。</p> : <div className="configured-models-list">
      {credentials.map(([id, credential]) => {
        const count = (draft.models?.entries ?? []).filter(model => model.credentialId === id).length;
        return <div className="configured-model-item" key={id} data-testid={`configured-provider-${id}`}>
          <ProviderIcon id={credential.platform || (draft.models?.entries ?? []).find(model => model.credentialId === id)?.provider || id} /><div className="configured-model-main"><strong>{credential.displayName || id}</strong><span className="muted">{credential.platform || id} · {id} · {count} 个模型</span></div>
          <div className="configured-model-meta"><Pill tone={credentialState[id] ? 'success' : 'warn'}>{credentialState[id] ? '凭据就绪' : '凭据缺失'}</Pill></div>
          <div className="configured-model-actions">
            <Button size="sm" data-testid={`configured-provider-edit-${id}`} onClick={() => onEdit(id)}>编辑</Button>
            <Button size="sm" data-testid={`configured-provider-delete-${id}`} onClick={() => onDelete(id)}>删除</Button>
          </div>
        </div>;
      })}
    </div>}
  </Card>;
}

/** Sidebar sections in their displayed order. */
interface SettingsSection {
  id: string;
  label: string;
}

const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: 'settings-overview', label: '常规' },
  { id: 'settings-archived', label: '归档对话' },
];

type ProbeResponse = {
  models?: { id?: unknown; name?: unknown }[];
  modelsError?: unknown;
  credentialConfigured?: unknown;
  verification?: { ok?: unknown; error?: unknown; skipped?: unknown };
};

function probeModelsFrom(response: ProbeResponse): ProbeModel[] {
  const list = Array.isArray(response.models) ? response.models : [];
  const models: ProbeModel[] = [];
  for (const item of list) {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    if (!id) continue;
    models.push({ id, ...(typeof item.name === 'string' && item.name.trim() ? { name: item.name.trim() } : {}) });
  }
  return models;
}

/** Vendored models.dev mapping (lane one); a missing module simply means the
 * model's metadata stays unknown and the user fills the fields by hand. */
async function lookupSnapshot(providerId: string, modelId: string): Promise<SnapshotMetadata | null> {
  try {
    modelsDevModule ??= loadModelsDev();
    const [mod, pricing] = await Promise.all([modelsDevModule, loadCcSwitchPricing()]);
    const found = mod.lookupModelMetadata(providerId, modelId) ?? null;
    const price = findCcSwitchPrice(modelId, pricing);
    if (!price) return found;
    return {
      ...(found ?? {}),
      cost: ccSwitchCost(price),
      currency: 'USD',
      sourceUrl: pricing.source,
      catalogRevision: `cc-switch:${pricing.updatedAt ?? 'unknown'}`,
    };
  } catch {
    return null;
  }
}

/**
 * B-1 two-step provider flow.
 *
 * Step 1 configures one provider (a supported platform or a custom
 * OpenAI/Anthropic-compatible endpoint) and its concurrency caps. Step 2 picks
 * models from `<baseUrl>/models` and fills their metadata from the build-time
 * models.dev snapshot. Both steps write through the settings autosave, so a
 * change applies to new requests immediately without interrupting in-flight
 * calls. Secrets never enter this component: only the keychain/password input
 * holds a value, and it is cleared as soon as the bridge stores it.
 */
function ProviderWorkbench({ draft, credentialState, bridge, mutate, openGuide, focusCredentialId, onCredentialStored }: {
  draft: RawConfig;
  credentialState: Record<string, boolean>;
  bridge: DesktopBridge | undefined;
  mutate: (change: (next: RawConfig) => void) => void;
  openGuide: boolean;
  focusCredentialId: string | null;
  onCredentialStored: (credentialId: string, configured?: boolean) => void;
}) {
  const [platforms, setPlatforms] = useState<PlatformPreset[]>([...FALLBACK_PLATFORMS]);
  const [platformsNote, setPlatformsNote] = useState('');
  const [platformId, setPlatformId] = useState<string>(FALLBACK_PLATFORMS[0]!.id);
  const [custom, setCustom] = useState<ProviderDraft>(customDraft);
  // One platform may hold several accounts, so its credential id and variable name
  // can be overridden without retargeting the platform itself.
  const [account, setAccount] = useState<{ credentialId?: string; credentialRef?: string; label?: string }>({});
  const [key, setKey] = useState('');
  const [errors, setErrors] = useState<ProviderDraftErrors>({});
  const [busy, setBusy] = useState(false);
  const [keyResolved, setKeyResolved] = useState<Record<string, boolean>>({});
  const [verification, setVerification] = useState<{ ok: boolean; error?: string } | null>(null);
  const [probeModels, setProbeModels] = useState<ProbeModel[]>([]);
  const [picks, setPicks] = useState<ModelPick[]>([]);
  const [manualId, setManualId] = useState('');
  const [note, setNote] = useState('');
  const [selectedVendorId, setSelectedVendorId] = useState('');
  useEffect(() => {
    if (!focusCredentialId) return;
    setSelectedVendorId(focusCredentialId);
    const credential = draft.credentials?.[focusCredentialId];
    if (!credential) return;
    const model = draft.models?.entries.find(entry => entry.credentialId === focusCredentialId);
    const savedPlatform = credential.platform ?? model?.provider ?? focusCredentialId;
    const platform = platforms.some(item => item.id === savedPlatform) ? savedPlatform : 'custom';
    setPlatformId(platform);
    setAccount({ credentialId: focusCredentialId, credentialRef: credential.secretRef,
      ...(credential.displayName ? { label: credential.displayName } : {}) });
    if (platform === 'custom') {
      setCustom({ platformId: 'custom', credentialId: focusCredentialId, credentialRef: credential.secretRef,
        label: credential.displayName ?? focusCredentialId, baseUrl: model?.baseUrl ?? '', api: model?.api ?? 'openai-completions' });
    }
  }, [focusCredentialId, platforms]);
  const probedVendor = useRef<string | null>(null);
  const [concurrency, setConcurrency] = useState<ConcurrencyDraft>({ credentialLimit: '', sharedGroupId: '', sharedGroupLimit: '' });

  useEffect(() => {
    let cancelled = false;
    const request = platformsRequest();
    void api<unknown>(request.url).then(result => {
      if (cancelled) return;
      const list = normalizePlatforms(result);
      if (list.length) setPlatforms(list);
      else setPlatformsNote('平台目录为空，使用内置模板。');
    }).catch(() => { if (!cancelled) setPlatformsNote('平台目录读取失败，使用内置模板。'); });
    return () => { cancelled = true; };
  }, []);

  const selected = platformById(platforms, platformId);
  const isCustom = isCustomPlatform(platformId) || selected?.custom === true;
  // The selected credential, not the platform, decides the name and variable: that is
  // what lets an existing account of the platform be renamed here.
  const base: ProviderDraft = !isCustom && selected ? draftForCredential(selected, draft.credentials, account.credentialId ?? selected.id) : custom;
  const active: ProviderDraft = { ...base, ...account };
  const editAccount = (next: { credentialId?: string; credentialRef?: string; label?: string }) => {
    if (isCustom) setCustom(current => ({ ...current, ...next }));
    else setAccount(current => ({ ...current, ...next }));
  };
  // credentialConfigured / credentialRef come from the daemon catalog; the
  // card must use the daemon's own ref name so the reason names the right env var.
  // The daemon's per-credential answer outranks the platform flag: one platform may hold several
  // accounts, so another account's variable says nothing about this one. Without that precedence the card
  // reports 凭据已解析 for an account that has no value, and the only symptom is a model that silently
  // never dispatches (its credential is dropped before the model list is built).
  const accountHasNoValue = credentialState[active.credentialId] === false && !keyResolved[active.credentialId];
  const resolved = !accountHasNoValue && Boolean(keyResolved[active.credentialId] || credentialState[active.credentialId] || selected?.credentialConfigured);
  const requiredProblems = missingRequiredModelFields(draft.models?.entries ?? []);

  useEffect(() => {
    setConcurrency(readConcurrency(draft, active.credentialId));
    setVerification(null);
    setErrors({});
  }, [active.credentialId]);
  // 切账户（凭据 id）之后，② 的模型列表必须跟着走：那些行是从另一个账户的端点取回来的，留在屏幕上就等于
  // 把 A 的模型按到 B 头上（保存时写进 B）。列表属于账户，所以切到同名厂商让它重新获取一次。
  const shownAccount = useRef<string | undefined>(undefined);
  useEffect(() => {
    const previous = shownAccount.current;
    shownAccount.current = active.credentialId;
    if (previous === undefined || previous === active.credentialId) return;
    setProbeModels([]);
    setPicks([]);
    setNote('');
    const next = vendors.find(vendor => vendor.id === active.credentialId);
    if (next) setSelectedVendorId(next.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.credentialId]);
  const entries = draft.models?.entries ?? [];
  const activeEntries = entries.filter(entry => entry.credentialId === active.credentialId);
  // ② 选择模型 has its own vendor picker: only credentials the config already
  // holds (or the daemon resolved) are listed; everything else stays hidden.
  const vendors = modelVendorsFrom(draft, platforms);
  const selectedVendor = vendors.find(vendor => vendor.id === selectedVendorId);
  const vendorDraft = selectedVendor ? draftFromModelVendor(selectedVendor) : undefined;
  const vendorBlockedReason = selectedVendor && !selectedVendor.baseUrl.trim()
    ? '该厂商还没有可用的端点地址：请先在「① 配置厂商」填写并保存 Base URL'
    : null;
  const vendorEntries = selectedVendor ? entries.filter(entry => entry.credentialId === selectedVendor.id) : [];
  const keyGuidance = keyEntryGuidance({ hasBridge: Boolean(bridge), credentialRef: active.credentialRef });
  const limitIds = concurrencyControlIds(active.credentialId);
  // Ids the user typed because the endpoint has no /models reply must stay
  // visible as rows, otherwise 手动添加 looks like it did nothing.
  const manualRows: ProbeModel[] = picks
    .filter(pick => pick.manual && !probeModels.some(model => model.id === pick.modelId))
    .map(pick => ({ id: pick.modelId, ...(pick.name ? { name: pick.name } : {}) }));
  /** A save must verify a real model. A vendor without a model list has no
   * `/models` reply to fall back on, so fall back to the model that this
   * credential already uses instead of skipping verification. */
  const verifyCandidate = (): string | undefined =>
    picks.find(pick => pick.selected)?.modelId?.trim()
    ?? (manualId.trim() || undefined)
    ?? activeEntries[0]?.modelId?.trim()
    ?? activeEntries[0]?.id;

  const choosePlatform = (id: string) => {
    setPlatformId(id);
    setAccount({});
    setPicks([]);
    setProbeModels([]);
    setVerification(null);
    setKey('');
  };

  const copyExportLine = async (line: string) => {
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(line);
      toast('已复制环境变量 export 行', 'success');
    } catch {
      toast('复制失败，请手动选择这一行复制', 'danger');
    }
  };

  const runProbe = async (target: ProviderDraft, options: { modelId?: string; updateList?: boolean; verification?: boolean } = {}) => {
    const updateList = options.updateList !== false;
    const updateVerification = options.verification !== false;
    setBusy(true);
    if (updateList) setNote('正在请求厂商接口…');
    try {
      const request = probeRequest(target, crypto.randomUUID(), options.modelId);
      const result = await api<ProbeResponse>(request.url, request.init);
      const list = probeModelsFrom(result);
      if (updateList) {
        setProbeModels(list);
        setPicks(current => mergeProbeModels(list, current));
        const modelsError = typeof result.modelsError === 'string' ? result.modelsError : '';
        setNote(list.length
          ? `已探测到 ${list.length} 个模型。`
          : modelsError
            ? probeFailureNote(modelsError)
            : '该端点未返回模型列表，可手动添加模型 id。');
      }
      if (updateVerification) {
        const probe = result.verification;
        const ok = Boolean(probe && probe.ok === true);
        setVerification(ok ? { ok: true } : { ok: false, error: typeof probe?.error === 'string' ? probe.error : '厂商未返回可验证的响应' });
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (updateVerification) setVerification({ ok: false, error: message });
      // Never drop the vendor's own rejection wording: it is the only clue for
      // the manual-id fallback.
      if (updateList) setNote(probeFailureNote(message));
    } finally {
      setBusy(false);
    }
  };

  // Selecting a vendor auto-fetches its model list exactly once per switch. The
  // effect depends on the resolved vendor source, not only the id, so a vendor
  // that only becomes resolvable after the catalog/config loads still triggers.
  // A vendor whose endpoint is not ready yet is NOT recorded, so it auto-probes
  // once the endpoint arrives instead of being silently skipped.
  useEffect(() => {
    const vendor = selectedVendorId ? vendors.find(item => item.id === selectedVendorId) : undefined;
    const decision = autoProbeDecision(selectedVendorId, probedVendor.current, vendor?.baseUrl ?? '');
    if (!decision.probe || !vendor) return;
    probedVendor.current = decision.recorded;
    void runProbe(draftFromModelVendor(vendor), { verification: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVendorId, vendors]);

  const saveProvider = async () => {
    const found = validateProviderDraft(active, { custom: isCustom, hasKey: Boolean(key.trim()) || resolved });
    setErrors(found);
    if (hasProviderErrors(found)) {
      toast(isCustom ? '请补全自定义厂商的厂商名、Base URL、兼容格式与 API KEY' : '请填写 API KEY 或订阅凭据', 'danger');
      return;
    }
    setBusy(true);
    try {
      if (bridge && key.trim()) {
        const stored = await bridge.saveSecret(active.credentialRef, key.trim());
        if (!stored.stored) {
          toast(`密钥保存失败：${stored.message ?? '钥匙串不可用'}`, 'danger');
          return;
        }
        setKeyResolved(current => ({ ...current, [active.credentialId]: true }));
        onCredentialStored(active.credentialId);
        setKey('');
      }
      mutate(next => {
        const credentials = { ...(next.credentials ?? {}) };
        credentials[active.credentialId] = accountCredentialEntry(credentials[active.credentialId], {
          credentialId: active.credentialId,
          credentialRef: active.credentialRef,
          label: active.label,
          platformId: active.platformId,
          custom: isCustom,
        });
        next.credentials = credentials;
        writeConcurrency(next, active.credentialId, concurrency);
      });
    } finally {
      setBusy(false);
    }
    const candidate = verifyCandidate();
    await runProbe(active, { ...(candidate ? { modelId: candidate } : {}), updateList: false });
  };

  const addSelected = async () => {
    const vendor = selectedVendor;
    if (!vendor) {
      toast('请先选择厂商', 'danger');
      return;
    }
    const chosen = selectedProbeModels(picks);
    if (!chosen.length) {
      toast('请先勾选至少一个模型，或手动添加模型 id', 'danger');
      return;
    }
    setBusy(true);
    const baseUrl = vendor.baseUrl.trim();
    const prepared = await Promise.all(chosen.map(async pick => ({ pick, metadata: await lookupSnapshot(vendor.platformId, pick.modelId) })));
    mutate(next => {
      const list = [...(next.models?.entries ?? [])];
      const taken = list.map(entry => entry.id);
      for (const { pick, metadata } of prepared) {
        const id = uniqueLocalModelId(vendor.platformId, pick.modelId, taken);
        taken.push(id);
        const built = draftToModelEntry(buildEntryDraft({
          id, provider: vendor.platformId, baseUrl, api: vendor.api, credentialId: vendor.id, modelId: pick.modelId,
          metadata,
        }));
        const headers = modelRequestHeaders({ provider: vendor.platformId, baseUrl });
        list.push({ ...built, thinkingOptions: thinkingOptionsFromMetadata(metadata), ...(headers ? { headers } : {}) });
      }
      next.models = { entries: list };
    });
    setPicks(current => current.map(pick => chosen.some(item => item.modelId === pick.modelId) ? { ...pick, selected: false } : pick));
    setBusy(false);
    const missingCaps = prepared.filter(({ metadata }) => {
      const fields = metadataToFields(metadata);
      return !hasRequiredModelFields({ grade: 'pending', contextWindow: fields.contextWindow, maxTokens: fields.maxTokens });
    }).length;
    toast(`已添加所选模型；请为每个模型选择等级${missingCaps ? `，并为其中 ${missingCaps} 个填写上下文上限/最大输出` : ''}后才能保存（价格等未知项可留空，不会按 0 计算）`, 'info');
  };

  const addManual = () => {
    const id = manualId.trim();
    if (!id) return;
    setPicks(current => current.some(pick => pick.modelId === id) ? current : [...current, { modelId: id, selected: true, manual: true }]);
    setManualId('');
  };

  const fieldError = (field: keyof ProviderDraftErrors) => errors[field];
  const mark = (field: keyof ProviderDraftErrors) => (errors[field] ? 'true' : undefined);

  return (
    <>
      <section id="settings-credentials" className="settings-section" data-testid="provider-setup">
        <Card title="① 配置厂商" icon="link" subtitle="已支持厂商只需填 API KEY 或订阅凭据；自定义厂商需填名称、Base URL 与兼容格式。保存后自动发起一次最小请求验证，失败会原样显示厂商错误。">
          <ProviderPicker choices={platforms} value={platformId} onChange={choosePlatform} testId="provider-platforms" testIdPrefix="provider-platform-" disabled={busy} />
          {selected?.docsUrl && <p className="provider-help"><a href={selected.docsUrl} target="_blank" rel="noreferrer">获取 {selected.label} API 凭据 ↗</a></p>}
          {platformsNote && <p className="muted" data-testid="provider-platforms-note">{platformsNote}</p>}
          {selected?.notes?.length ? <p className="muted">{selected.notes.join('；')}</p> : null}
          {!selected?.modelsListSupported && <p className="muted" data-testid="provider-no-models-list">目录提示该端点可能不支持 /models 列表；保存后仍会尝试请求并以厂商响应为准，失败时请手动添加模型 id。</p>}

          <div className="card-grid">
            {isCustom ? (
              <>
                <Field label="Base URL" error={fieldError('baseUrl')}><input className="input" data-testid="provider-baseUrl" data-invalid={mark('baseUrl')} value={custom.baseUrl} onChange={event => setCustom({ ...custom, baseUrl: event.target.value })} placeholder="https://gateway.example.com/v1" /></Field>
                <Field label="兼容格式" error={fieldError('api')}>
                  <select className="select" data-testid="provider-api" data-invalid={mark('api')} value={custom.api} onChange={event => setCustom({ ...custom, api: event.target.value as ProviderDraft['api'] })}>
                    {PROVIDER_COMPATIBILITIES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                  </select>
                </Field>
              </>
            ) : (
              <>
                <Field label="端点"><input className="input" value={active.baseUrl} readOnly data-testid="provider-baseUrl" /></Field>
                <Field label="兼容格式"><input className="input" value={PROVIDER_COMPATIBILITIES.find(item => item.id === active.api)?.label ?? active.api} readOnly data-testid="provider-api" /></Field>
              </>
            )}
            <Field label="名称" hint="用量页与模型列表显示这个名字；支持自定义" error={fieldError('label')}><input className="input" data-testid="provider-label" data-invalid={mark('label')} value={active.label} onChange={event => editAccount({ label: event.target.value })} placeholder={isCustom ? '例如 本地网关' : undefined} /></Field>
            <Field label="凭据 id" hint={isCustom ? undefined : '同一平台可配置多个账户：id 不同即不同账户'} data-testid="provider-credentialId-field"><input className="input" data-testid="provider-credentialId" data-invalid={mark('credentialId')} value={active.credentialId} onChange={event => editAccount({ credentialId: event.target.value })} /></Field>
            <div className="field-full">
              <Field label="环境变量（credentialRef）" hint="配置文件只保存这个名字" error={fieldError('credentialRef')}><input className="input" data-testid="provider-credentialRef" data-invalid={mark('credentialRef')} value={active.credentialRef} onChange={event => editAccount({ credentialRef: event.target.value })} /></Field>
            </div>
          </div>

          {isCustom ? null : (
            <div className="row" style={{ marginTop: 8 }}>
              <Button
                size="sm"
                icon="plus"
                data-testid="provider-add-account"
                disabled={busy}
                onClick={() => {
                  if (!selected) return;
                  const next = nextAccountDraft(selected, Object.keys(draft.credentials ?? {}));
                  editAccount({ credentialId: next.credentialId, credentialRef: next.credentialRef });
                  setKey('');
                }}
              >
                同一平台再加一个账户
              </Button>
              <span className="muted">每个账户有自己的密钥与额度；模型在下一步选择用哪个账户</span>
            </div>
          )}

          {selected?.oauthProvider === 'openrouter' && <ProviderLogin key={active.credentialRef} credentialRef={active.credentialRef} configured={resolved} onChange={configured => {
            setKeyResolved(current => ({ ...current, [active.credentialId]: configured }));
            onCredentialStored(active.credentialId, configured);
            setPlatforms(current => current.map(platform => platform.id === platformId ? { ...platform, credentialConfigured: configured } : platform));
          }} />}
          {bridge ? (
            <Field label={keyGuidance.title} hint="只写入系统钥匙串，不进入配置文件、接口响应或页面" error={fieldError('key')}>
              <input className="input" style={{ maxWidth: 'none' }} type="password" data-testid="provider-key" data-invalid={mark('key')} value={key} onChange={event => setKey(event.target.value)} placeholder="sk-…" />
            </Field>
          ) : (
            <div className="key-guidance" data-testid="provider-key-guidance">
              <p className="key-guidance-title" data-testid="provider-key-hint">{keyGuidance.title}</p>
              {keyGuidance.lines.map((line, index) => <p key={index} className="muted key-guidance-line">{line}</p>)}
              {fieldError('key') && <p className="field-error" data-testid="provider-key-error">{fieldError('key')}</p>}
              <div className="row key-guidance-export">
                <code className="mono" data-testid="provider-key-env">{keyGuidance.envVar}</code>
                <Button size="sm" icon="copy" data-testid="provider-key-copy" onClick={() => void copyExportLine(keyGuidance.exportLine)}>复制 export 行</Button>
              </div>
              <code className="mono key-export" data-testid="provider-key-export">{keyGuidance.exportLine}</code>
            </div>
          )}

          <div className="provider-concurrency" data-testid="provider-concurrency">
            <p className="field-hint">并发控制（保存后立即对新请求生效，不中断在途请求）：每个凭据上限与跨凭据共享组上限都在本厂商条目内编辑。</p>
            <div className="row">
              <Field label="本凭据并发上限"><input className="input" style={{ width: 120 }} type="number" data-testid={limitIds.credential} value={concurrency.credentialLimit} onChange={event => setConcurrency({ ...concurrency, credentialLimit: event.target.value })} placeholder="默认" /></Field>
              <Field label="共享组 id"><input className="input" style={{ width: 180 }} data-testid={limitIds.groupId} value={concurrency.sharedGroupId} onChange={event => setConcurrency({ ...concurrency, sharedGroupId: event.target.value })} placeholder="可选" /></Field>
              <Field label="共享组并发上限"><input className="input" style={{ width: 120 }} type="number" data-testid={limitIds.groupLimit} value={concurrency.sharedGroupLimit} onChange={event => setConcurrency({ ...concurrency, sharedGroupLimit: event.target.value })} placeholder="默认" /></Field>
            </div>
          </div>

          <div className="row" style={{ marginTop: 12 }}>
            <Button variant="primary" icon="check" data-testid="provider-save" disabled={busy} onClick={() => void saveProvider()}>{busy ? '验证中…' : '保存并验证'}</Button>
            <Pill tone={resolved ? 'success' : 'warn'} testid="provider-credential-state">{resolved ? '凭据已解析' : '凭据缺失'}</Pill>
          </div>
          {verification && (
            <p data-testid="provider-verification" className={verification.ok ? 'muted' : 'field-error'}>
              {verification.ok ? '验证成功：厂商已返回最小请求响应。' : `验证失败：${verification.error}`}
            </p>
          )}
        </Card>
      </section>

      <section id="settings-models" className="settings-section" data-testid="provider-models">
        <Card title="② 选择模型" icon="bolt" subtitle={selectedVendor ? `从 ${selectedVendor.label} 的 ${selectedVendor.baseUrl || '端点'}/models 自动探测可用模型；端点不支持列表时可手动添加模型 id` : '只列出已配置凭据的厂商：选中厂商后自动获取它的可用模型列表'}
          actions={<>
            <Button size="sm" icon="refresh" data-testid="model-probe" disabled={busy || !selectedVendor || Boolean(vendorBlockedReason)} onClick={() => { if (vendorDraft) void runProbe(vendorDraft, { verification: false }); }}>重新获取</Button>
            <Button size="sm" icon="plus" data-testid="model-add-selected" disabled={busy || !selectedVendor || Boolean(vendorBlockedReason) || !picks.some(pick => pick.selected)} onClick={() => void addSelected()}>添加所选模型</Button>
          </>}>
          <div className="model-vendor-picker">
            <Field label="厂商" hint="只显示配置里已有凭据的厂商；选中即自动获取模型">
              <select className="select" data-testid="model-vendor-select" value={selectedVendorId} disabled={!vendors.length} onChange={event => setSelectedVendorId(event.target.value)}>
                <option value="">选择厂商…</option>
                {vendors.map(vendor => <option key={vendor.id} value={vendor.id}>{`${vendor.label} · 已有 ${vendor.modelCount} 个`}</option>)}
              </select>
            </Field>
          </div>
          {!vendors.length && <p className="muted" data-testid="model-vendor-empty">还没有已配置凭据的厂商：请先在「① 配置厂商」保存一次。</p>}
          {vendorBlockedReason && <p className="field-error" data-testid="provider-credential-blocked">{vendorBlockedReason}</p>}
          {requiredProblems.length > 0 && <p className="field-error" data-testid="model-required-missing">有 {requiredProblems.length} 个模型缺少必填字段（{requiredProblems.map(problem => problem.id).join('、')}）；请补全上下文上限/最大输出/模型等级，并确保价格成套填写（不完整的价格不会按 0 计算）。</p>}
          <p className="muted" data-testid="model-probe-note">{note || (selectedVendor ? '选中厂商后会自动获取模型；也可点「重新获取」。' : '先选择一个已配置凭据的厂商。')}</p>
          {(probeModels.length > 0 || manualRows.length > 0) && (
            <div className="model-probe-list" data-testid="model-probe-list">
              {[...probeModels, ...manualRows].map(model => {
                const pick = picks.find(item => item.modelId === model.id);
                return (
                  <label key={model.id} className="list-item" style={{ cursor: 'pointer' }}>
                    <input type="checkbox" disabled={Boolean(vendorBlockedReason)} data-testid={`model-probe-${model.id}`} checked={Boolean(pick?.selected)} onChange={event => setPicks(current => current.map(item => item.modelId === model.id ? { ...item, selected: event.target.checked } : item))} />
                    <span className="grow">{model.name ?? model.id} <span className="muted">{model.id}</span></span>
                  </label>
                );
              })}
            </div>
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <input className="input" style={{ width: 260 }} data-testid="model-manual-id" value={manualId} disabled={Boolean(vendorBlockedReason)} onChange={event => setManualId(event.target.value)} placeholder="手动添加的模型 id" />
            <Button size="sm" data-testid="model-manual-add" disabled={Boolean(vendorBlockedReason)} onClick={addManual}>手动添加</Button>
          </div>

          {!vendorEntries.length && <p className="muted">该厂商下还没有模型。</p>}
          {vendorEntries.map(entry => {
            const index = entries.indexOf(entry);
            const fieldIssues = modelFieldErrors(entry);
            const complete = completeCost(entry.cost);
            const thinkingOptions = entry.thinkingOptions ?? [];
            const selectedThinkingLevel = thinkingOptions.length
              ? nearestLevel(thinkingOptions, entry.defaultThinkingLevel ?? defaultThinkingLevelFor(thinkingOptions))
              : '';
            const staleThinkingLevel = entry.defaultThinkingLevel && entry.defaultThinkingLevel !== selectedThinkingLevel;
            const setCost = (field: 'input' | 'output' | 'cacheRead' | 'cacheWrite', raw: string) => mutate(next => {
              const target = next.models!.entries[index]!;
              const parsed = raw === '' ? undefined : Number(raw);
              const cost = withCostField(target.cost, field, parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined);
              if (cost) target.cost = cost; else delete target.cost;
              // A price is a set: only a complete one is known; a partial one is
              // marked unknown (never written as 0).
              const currency = target.pricing?.currency ?? '';
              if (completeCost(target.cost) && currency) target.pricing = { currency, unit: 'per_million_tokens', status: 'known' };
              else if (completeCost(target.cost)) target.pricing = { currency: 'USD', unit: 'per_million_tokens', status: 'known', sourceUrl: 'manual' };
              else if (currency) target.pricing = { currency, unit: 'per_million_tokens', status: 'unknown' };
              else delete target.pricing;
            });
            return (
              <div className="model-card" key={entry.id} data-testid={`provider-model-${index}`}>
                <div className="card-body">
                  <div className="row">
                    <strong className="grow">{entry.modelId ?? entry.id}</strong>
                    <Pill tone={complete ? 'info' : 'warn'} testid={`model-${index}-price`}>{complete ? `价格 输入 ${complete.input}/输出 ${complete.output}/缓存读 ${complete.cacheRead}/缓存写 ${complete.cacheWrite} 每百万（${entry.pricing?.currency ?? 'USD'}）` : '价格未知（pricing.status=unknown，不会按 0 计算）'}</Pill>
                  </div>
                  <div className="row">
                    <Field label="上下文上限" error={fieldIssues.contextWindow}><input className="input" style={{ width: 120 }} type="number" data-testid={`model-${index}-context`} data-invalid={fieldIssues.contextWindow ? 'true' : undefined} value={entry.contextWindow ?? ''} placeholder="未知，请填写" onChange={event => mutate(next => { const target = next.models!.entries[index]!; const raw = event.target.value; if (raw === '') delete target.contextWindow; else target.contextWindow = Number(raw); })} /></Field>
                    <Field label="最大输出" error={fieldIssues.maxTokens}><input className="input" style={{ width: 120 }} type="number" data-testid={`model-${index}-maxTokens`} data-invalid={fieldIssues.maxTokens ? 'true' : undefined} value={entry.maxTokens ?? ''} placeholder="未知，请填写" onChange={event => mutate(next => { const target = next.models!.entries[index]!; const raw = event.target.value; if (raw === '') delete target.maxTokens; else target.maxTokens = Number(raw); })} /></Field>
                    <Field label="模型等级" error={fieldIssues.grade}>
                      <select className="select" style={{ width: 130 }} data-testid={`model-${index}-grade`} data-invalid={fieldIssues.grade ? 'true' : undefined} value={entry.grade ?? ''} onChange={event => mutate(next => { const target = next.models!.entries[index]!; if (event.target.value) target.grade = event.target.value; else delete target.grade; })}>
                        <option value="">请选择</option>
                        <ModelGradeOptions />
                      </select>
                    </Field>
                    <Field label="默认思考强度">
                      <select className="select" data-testid={`model-${index}-thinking`} value={selectedThinkingLevel} onChange={event => mutate(next => { const target = next.models!.entries[index]!; if (event.target.value) target.defaultThinkingLevel = event.target.value as ModelThinkingLevel; else delete target.defaultThinkingLevel; })}>
                        {thinkingOptions.map(option => <option key={option.level} value={option.level}>{thinkingOptionLabel(option)}</option>)}
                      </select>
                    </Field>
                    {staleThinkingLevel && <Button size="sm" onClick={() => mutate(next => { next.models!.entries[index]!.defaultThinkingLevel = selectedThinkingLevel as ModelThinkingLevel; })}>原默认值 {entry.defaultThinkingLevel} 不受支持，修正为 {selectedThinkingLevel}</Button>}
                  </div>
                  <div className="row">
                    <label className="checkbox-row"><input type="checkbox" data-testid={`model-${index}-images`} checked={(entry.input ?? ['text']).includes('image')} onChange={event => mutate(next => { next.models!.entries[index]!.input = event.target.checked ? ['text', 'image'] : ['text']; })} /><span>支持图片输入</span></label>
                    <Field label="输入价/百万" error={fieldIssues.cost}><input className="input" style={{ width: 100 }} type="number" placeholder="未知" data-testid={`model-${index}-input-cost`} value={entry.cost?.input ?? ''} onChange={event => setCost('input', event.target.value)} /></Field>
                    <Field label="输出价/百万"><input className="input" style={{ width: 100 }} type="number" placeholder="未知" data-testid={`model-${index}-output-cost`} value={entry.cost?.output ?? ''} onChange={event => setCost('output', event.target.value)} /></Field>
                    <Field label="缓存读/百万"><input className="input" style={{ width: 100 }} type="number" placeholder="未知" data-testid={`model-${index}-cache-read-cost`} value={entry.cost?.cacheRead ?? ''} onChange={event => setCost('cacheRead', event.target.value)} /></Field>
                    <Field label="缓存写/百万"><input className="input" style={{ width: 100 }} type="number" placeholder="未知" data-testid={`model-${index}-cache-write-cost`} value={entry.cost?.cacheWrite ?? ''} onChange={event => setCost('cacheWrite', event.target.value)} /></Field>
                    <Field label="币种"><input className="input" style={{ width: 80 }} placeholder="USD" data-testid={`model-${index}-currency`} value={entry.pricing?.currency ?? ''} onChange={event => mutate(next => { const target = next.models!.entries[index]!; const currency = event.target.value.trim().toUpperCase(); if (!currency) { delete target.pricing; return; } target.pricing = { currency, unit: 'per_million_tokens', status: completeCost(target.cost) ? 'known' : 'unknown', sourceUrl: 'manual' }; })} /></Field>
                    <div className="topbar-spacer" />
                    <Button size="sm" variant="danger" data-testid={`model-${index}-remove`} onClick={() => mutate(next => { next.models!.entries.splice(index, 1); })}>删除</Button>
                  </div>
                  {fieldIssues.cost && <p className="field-error" data-testid={`model-${index}-cost-error`}>{fieldIssues.cost}</p>}
                </div>
              </div>
            );
          })}
        </Card>
      </section>

      {openGuide && <section className="settings-feature">
        <h2>连接与配置向导</h2>
        <Setup onSaved={() => undefined} />
      </section>}
    </>
  );
}

export function Settings({ openGuide = false }: { openGuide?: boolean } = {}) {
  const [active, setActive] = useState(openGuide ? 'settings-models' : 'settings-overview');
  const [search, setSearch] = useState('');
  useEffect(() => {
    setActive(openGuide ? 'settings-models' : 'settings-overview');
  }, [openGuide]);
  const sections = openGuide ? [{ id: 'settings-models', label: '连接向导' }] : SETTINGS_SECTIONS;
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
              <Icon name={section.id === 'settings-models' ? 'bolt' : section.id === 'settings-archived' ? 'archive' : 'settings'} size={16} />
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
            <SettingsAdvanced active={active} autoSyncSubscriptions={!openGuide} openGuide={openGuide} />
            {active === 'settings-overview' && <>
              <PreferencesPage />
              <details className="settings-project-status">
                <summary>项目状态与本地基线</summary>
                <ProjectGitCard />
              </details>
            </>}
            {active === 'settings-archived' && <section id="settings-archived" className="settings-section"><ArchivedConversations /></section>}
          </div>
        </div>
      </main>
    </div>
  );
}

/** Model management is a normal workspace tab; only first-run setup uses the takeover shell. */
export function ModelsPage() {
  return <div className="models-page" data-testid="models-page"><SettingsAdvanced active="settings-models" autoSyncSubscriptions openGuide={false} /></div>;
}

function SettingsAdvanced({ active, autoSyncSubscriptions, openGuide }: { active: string; autoSyncSubscriptions: boolean; openGuide: boolean }) {
  const [draft, setDraft] = useState<RawConfig | null>(null);
  const [credentialState, setCredentialState] = useState<Record<string, boolean>>({});
  const [focusCredentialId, setFocusCredentialId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(openGuide);
  const [editorTarget, setEditorTarget] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [effectiveRevision, setEffectiveRevision] = useState<number | null>(null);
  const [runningSource, setRunningSource] = useState<Startup['source']>(undefined);
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
      const pricing = await loadCcSwitchPricing();
      let pricingChanged = false;
      if (next.models) {
        next.models.entries = await Promise.all(next.models.entries.map(async entry => {
          const modelId = entry.modelId ?? entry.id;
          const price = findCcSwitchPrice(modelId, pricing);
          const cost = price ? ccSwitchCost(price) : undefined;
          const catalogRevision = `cc-switch:${pricing.updatedAt ?? 'unknown'}`;
          const priceChanged = Boolean(price) && (
            JSON.stringify(entry.cost ?? null) !== JSON.stringify(cost ?? null)
            || entry.pricing?.sourceUrl !== pricing.source
            || entry.pricing?.catalogRevision !== catalogRevision
            || entry.pricing?.status !== 'known'
          );
          if (priceChanged) pricingChanged = true;
          return {
            ...entry,
            ...(price && cost ? {
              cost,
              pricing: {
                currency: 'USD',
                unit: 'per_million_tokens' as const,
                sourceUrl: pricing.source,
                catalogRevision,
                status: 'known' as const,
              },
            } : {}),
            thinkingOptions: thinkingOptionsFromMetadata(await lookupSnapshot(entry.provider, modelId)),
          };
        }));
      }
      clearTimeout(saveTimer.current);
      editVersion.current = merged.changed || pricingChanged ? 1 : 0;
      savePending.current = false;
      latestDraft.current = next;
      latestRevision.current = response.revision;
      setDraft(next);
      if (!next.models?.entries.length) setEditorOpen(true);
      setCredentialState({
        ...Object.fromEntries(Object.entries(response.config.credentials ?? {}).map(([id, credential]) => [id, Boolean(credential.configured)])),
        ...Object.fromEntries(Object.keys(detected).map(id => [id, true])),
      });
      setRevision(response.revision);
      // The config response carries the saved/effective pair from one read.
      // A delayed startup snapshot must not replace a newer known revision.
      setEffectiveRevision(current => response.effectiveRevision === undefined ? current
        : Math.max(current ?? response.effectiveRevision, response.effectiveRevision));
      setDirty(merged.changed || pricingChanged);
      setError(null);
      setStatus(merged.changed
        ? `已同步 ${Object.keys(detected).join('、')} 的凭据引用`
        : pricingChanged
          ? `已按 ${pricing.source} 更新模型定价`
          : '');
      if (merged.changed || pricingChanged) scheduleSave(0);
    } catch (reason) {
      setError(reason as ApiError);
    }
  }, [autoSyncSubscriptions]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!editorOpen || !editorTarget) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(editorTarget)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setEditorTarget(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [editorOpen, editorTarget]);
  useEffect(() => () => {
    clearTimeout(saveTimer.current);
    if (editVersion.current > 0) void persistDraft(editVersion.current);
  }, []);
  useEffect(() => {
    void api<Startup>('/api/startup').then(startup => {
      setEffectiveRevision(current => startup.effectiveRevision === undefined ? current
        : Math.max(current ?? startup.effectiveRevision, startup.effectiveRevision));
      setRunningSource(startup.source);
    }).catch(() => undefined);
  }, []);

  const configurationPage = active === 'settings-overview' || active === 'settings-models';
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
    if (version === 0) return;
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
    // The config parser requires positive contextWindow/maxTokens. A model whose
    // snapshot hit did not cover them must be filled in first, so block the save
    // with a named reason instead of sending a document the daemon will reject.
    const missing = missingRequiredModelFields(document.models?.entries ?? []);
    if (missing.length) {
      const names = missing.map(problem => problem.id).join('、');
      setError(Object.assign(new Error(`已阻止保存：模型 ${names} 缺少必填的上下文上限/最大输出/模型等级，或价格未成套填写；请修正后再试（其余未知项可留空，但绝不按 0 计算）`), { field: 'models.entries' }));
      setStatus('');
      return;
    }
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
          document: { ...toDocument(document), version: 1 },
        }),
      });
      latestRevision.current = response.revision;
      setRevision(response.revision);
      const appliedRevision = response.effectiveRevision ?? response.revision;
      setEffectiveRevision(current => Math.max(current ?? appliedRevision, appliedRevision));
      const pending = response.applied === false;
      setStatus(`已自动保存 revision ${response.revision}${pending ? `，等待生效：${response.reason ?? '需要重启守护进程'}` : '，已应用到当前守护进程'}${response.configured === false ? '（尚未配置可用凭据，仅查看模式）' : ''}`);
      if (!pending) window.dispatchEvent(new Event('graph:settings-changed'));
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
      if (editVersion.current > 0 && (savePending.current || editVersion.current !== version)) {
        savePending.current = false;
        scheduleSave(120);
      }
    }
  }
  const mutate = (change: (next: RawConfig) => void) => {
    // Clone the newest draft rather than the render-scope value: two edits that
    // land in the same render frame would otherwise make the second one discard
    // the first, so a freshly added model silently vanishes from the document.
    const next = structuredClone(latestDraft.current ?? draft) as RawConfig;
    change(next);
    latestDraft.current = next;
    editVersion.current += 1;
    setDraft(next);
    setDirty(true);
    setStatus('');
    scheduleSave();
  };
  const invalid = (field: string) => error?.field === field ? 'true' : undefined;
  const configurationMessages = <>
    {error && <p data-testid="config-error" style={{ color: 'var(--danger)', margin: 0 }}>{error.message}{error.code ? `（${error.code}）` : ''}</p>}
    {status && <p data-testid="config-status" className="muted" style={{ margin: 0 }}>{status}</p>}
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
          <RunningSourceCard source={runningSource} />
          <ThemePlaceholder />
        </section>
      )}

      {active !== 'settings-overview' && <div className="settings-inline-messages">{configurationMessages}</div>}

      {active === 'settings-models' && <section className="settings-feature">
      <h2>模型</h2>
      <p className="muted">查看现有模型，或连接厂商并添加模型。配置会自动保存，对新请求立即生效。</p>
      <div className="settings-feature-stack">
      <ConfiguredModelsPanel draft={draft} credentialState={credentialState} mutate={mutate} onManage={target => {
        setEditorTarget(target);
        setEditorOpen(true);
      }} onEdit={credentialId => {
        setFocusCredentialId(credentialId);
        setEditorTarget('settings-credentials');
        setEditorOpen(true);
      }} />
      <ConfiguredProvidersPanel draft={draft} credentialState={credentialState} onEdit={credentialId => {
        setFocusCredentialId(credentialId);
        setEditorTarget('settings-credentials');
        setEditorOpen(true);
      }} onDelete={credentialId => {
        const secretRef = draft.credentials?.[credentialId]?.secretRef;
        const sharedSecret = Object.entries(draft.credentials ?? {}).some(([id, item]) => id !== credentialId && item.secretRef === secretRef);
        const linked = draft.models?.entries.filter(entry => entry.credentialId === credentialId).length ?? 0;
        if (!window.confirm(`删除厂商账户「${draft.credentials?.[credentialId]?.displayName ?? credentialId}」及其 ${linked} 个关联模型？`)) return;
        mutate(next => {
          const credential = next.credentials?.[credentialId];
          if (next.credentials) delete next.credentials[credentialId];
          if (next.models) {
            next.models.entries = next.models.entries.filter(entry => entry.credentialId !== credentialId);
            const remaining = new Set(next.models.entries.map(entry => entry.id));
            for (const grade of GRADES) {
              const preferences = next.models.preferences;
              if (preferences?.[grade]) preferences[grade] = preferences[grade]!.filter(id => remaining.has(id));
            }
            if (!next.models.entries.length) delete next.models;
          }
          if (next.limits?.credentials) delete next.limits.credentials[credentialId];
          const group = credential?.sharedLimitGroupId;
          if (group && !Object.values(next.credentials ?? {}).some(item => item.sharedLimitGroupId === group) && next.limits?.sharedGroups) delete next.limits.sharedGroups[group];
        });
        setCredentialState(current => { const next = { ...current }; delete next[credentialId]; return next; });
        if (focusCredentialId === credentialId) setFocusCredentialId(null);
        if (bridge && secretRef && !sharedSecret) void bridge.saveSecret(secretRef, null).then(result => {
          if (!result.stored) toast(`厂商配置已删除，但密钥移除失败：${result.message ?? '钥匙串不可用'}`, 'danger');
        }).catch(reason => toast(`厂商配置已删除，但密钥移除失败：${String(reason)}`, 'danger'));
      }} />
      <div className="model-editor-shell">
        <button type="button" className="model-editor-toggle" data-testid="model-editor-toggle" aria-expanded={editorOpen} onClick={() => setEditorOpen(value => !value)}>
          <Icon name="chevron" size={15} /><span>{editorOpen ? '收起厂商与模型管理' : '展开厂商与模型管理'}</span>
        </button>
        {editorOpen && <ProviderWorkbench draft={draft} credentialState={credentialState} bridge={bridge} mutate={mutate} openGuide={openGuide}
          focusCredentialId={focusCredentialId} onCredentialStored={(credentialId, configured = true) => setCredentialState(current => ({ ...current, [credentialId]: configured }))} />}
      </div>
      </div>
      </section>}

    </div>
  );
}
