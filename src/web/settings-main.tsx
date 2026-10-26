


import { useCallback,useEffect,useRef,useState } from 'react';

import { api } from './api.ts';



import { Card,Icon,Pill,Spinner,toast } from './ui.tsx';






import {
missingRequiredModelFields,
thinkingOptionsFromMetadata
} from './provider-form.ts';

import type { ApiError,ConfigResponse,RawConfig,Startup } from "./settings-config.tsx";
import { GRADES,ccSwitchCost,findCcSwitchPrice,loadCcSwitchPricing,mergeSubscriptionCredentials,toDocument,toDraft } from "./settings-config.tsx";
import { ArchivedConversations,PreferencesPage,ProjectGitCard,RunningSourceCard,ThemePlaceholder } from "./settings-general.tsx";
import { ConfiguredModelsPanel,ConfiguredProvidersPanel,SETTINGS_SECTIONS,lookupSnapshot } from "./settings-models.tsx";
import { useProviderWorkbenchState } from "./settings-provider-state.tsx";
import { ProviderWorkbenchView } from "./settings-provider-view.tsx";
import type { DesktopBridge } from './setup.ts';

export function ProviderWorkbench(props: {
  draft: RawConfig;
  credentialState: Record<string, boolean>;
  bridge: DesktopBridge | undefined;
  mutate: (change: (next: RawConfig) => void) => void;
  openGuide: boolean;
  focusCredentialId: string | null;
  onCredentialStored: (credentialId: string, configured?: boolean) => void;
}) {
const state = useProviderWorkbenchState(props);
if (state.fallback !== null) return state.fallback;
return <ProviderWorkbenchView {...state} />;
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

export function ModelsPage() {
  return <div className="models-page" data-testid="models-page"><SettingsAdvanced active="settings-models" autoSyncSubscriptions openGuide={false} /></div>;
}

export function SettingsAdvanced({ active, autoSyncSubscriptions, openGuide }: { active: string; autoSyncSubscriptions: boolean; openGuide: boolean }) {
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
