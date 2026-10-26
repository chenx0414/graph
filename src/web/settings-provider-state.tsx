


import { useCallback,useEffect,useRef,useState } from 'react';

import { api } from './api.ts';



import { toast } from './ui.tsx';



import { modelRequestHeaders } from '../catalog/models.ts';



import {
FALLBACK_PLATFORMS,
accountCredentialEntry,
autoProbeDecision,
buildEntryDraft,
concurrencyControlIds,
credentialResolved,
customDraft,
draftForCredential,
draftFromModelVendor,
draftToModelEntry,
hasProviderErrors,
hasRequiredModelFields,
isCustomPlatform,
keyEntryGuidance,
mergeProbeModels,
metadataToFields,
missingRequiredModelFields,
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
writeConcurrency,
type ConcurrencyDraft,
type ModelPick,
type PlatformPreset,
type ProbeModel,
type ProviderDraft,
type ProviderDraftErrors
} from './provider-form.ts';

import type { RawConfig } from "./settings-config.tsx";
import type { ProbeResponse } from "./settings-models.tsx";
import { lookupSnapshot,probeModelsFrom } from "./settings-models.tsx";
import type { DesktopBridge } from './setup.ts';

export function useProviderWorkbenchState({ draft, credentialState, bridge, mutate, openGuide, focusCredentialId, onCredentialStored }: {
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
  const base: ProviderDraft = !isCustom && selected ? draftForCredential(selected, draft.credentials, account.credentialId ?? selected.id) : custom;
  const active: ProviderDraft = { ...base, ...account };
  const editAccount = (next: { credentialId?: string; credentialRef?: string; label?: string }) => {
    if (isCustom) setCustom(current => ({ ...current, ...next }));
    else setAccount(current => ({ ...current, ...next }));
  };
  const resolved = credentialResolved({
    credentialState: credentialState[active.credentialId],
    keyResolved: keyResolved[active.credentialId],
    platformConfigured: selected?.credentialConfigured,
  });
  const requiredProblems = missingRequiredModelFields(draft.models?.entries ?? []);

  useEffect(() => {
    setConcurrency(readConcurrency(draft, active.credentialId));
    setVerification(null);
    setErrors({});
  }, [active.credentialId]);
  // ② 选择模型 has its own vendor picker: only credentials the config already
  // holds (or the daemon resolved) are listed; everything else stays hidden.
  const vendors = modelVendorsFrom(draft, platforms);
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
  }, [active.credentialId, vendors]);
  const entries = draft.models?.entries ?? [];
  const activeEntries = entries.filter(entry => entry.credentialId === active.credentialId);
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

  const runProbe = useCallback(async (target: ProviderDraft, options: { modelId?: string; updateList?: boolean; verification?: boolean } = {}) => {
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
  }, []);

  useEffect(() => {
    const vendor = selectedVendorId ? vendors.find(item => item.id === selectedVendorId) : undefined;
    const decision = autoProbeDecision(selectedVendorId, probedVendor.current, vendor?.baseUrl ?? '');
    if (!decision.probe || !vendor) return;
    probedVendor.current = decision.recorded;
    void runProbe(draftFromModelVendor(vendor), { verification: false });
  }, [selectedVendorId, vendors, runProbe]);

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

  return { fallback: null, platforms, platformId, choosePlatform, busy, selected, platformsNote, isCustom, fieldError, mark, custom, setCustom, active, editAccount, draft, setKey, resolved, setKeyResolved, onCredentialStored, setPlatforms, bridge, keyGuidance, key, copyExportLine, limitIds, concurrency, setConcurrency, saveProvider, verification, selectedVendor, vendorBlockedReason, vendorDraft, runProbe, picks, addSelected, selectedVendorId, vendors, setSelectedVendorId, requiredProblems, note, probeModels, manualRows, setPicks, manualId, setManualId, addManual, vendorEntries, entries, mutate, Number, openGuide };
}
