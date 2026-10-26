
/**
 * Pure logic for the two-step model-provider flow (B-1).
 *
 * Step 1 「配置厂商」 validates a provider draft, normalizes the platform
 * catalog served by `GET /api/providers` and edits the concurrency limits that
 * live *inside* a provider entry. Step 2 「选择模型」 merges the models probed
 * from `<baseUrl>/models` with the metadata mapped from the vendored models.dev
 * snapshot.
 *
 * The field names here mirror the daemon contract in `backend/internal/graph/server_providers.go`:
 * the display name is `label`, the credential reference is `credentialRef`
 * (never `name` / `secretRef`), and the probe body carries a `requestId`
 * idempotency key. This module stays presentational: it never reads the DOM,
 * never sends a request and never resolves an API key.
 */
import {
type ModelApi
} from '../catalog/models.ts';
import type { PlatformPreset,ProviderDraft } from "./provider-credentials.ts";
import { CUSTOM_PLATFORM_ID,platformById,PROVIDER_ROUTES } from "./provider-credentials.ts";

export interface ModelVendorConfig {
  credentials?: Record<string, { secretRef?: string; displayName?: string } | undefined>;
  models?: { entries: readonly { credentialId?: string; baseUrl?: string; api?: ModelApi }[] };
}

export interface ModelVendor {
  /** Config credential id (`credentials[<id>]`) — the models of this vendor. */
  id: string;
  /** Probe platform id: the preset id, or `custom` for a user-defined ref. */
  platformId: string;
  label: string;
  baseUrl: string;
  api: ModelApi;
  credentialRef: string;
  modelCount: number;
}

export function fallbackCredentialRef(id: string): string {
  return `GRAPH_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_KEY`;
}

export function modelVendorsFrom(
  config: ModelVendorConfig | null | undefined,
  platforms: readonly PlatformPreset[],
): ModelVendor[] {
  const credentials = config?.credentials ?? {};
  const entries = config?.models?.entries ?? [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const platform of platforms) {
    if (!platform.credentialConfigured || seen.has(platform.id)) continue;
    seen.add(platform.id);
    ids.push(platform.id);
  }
  for (const id of Object.keys(credentials)) {
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids.map(id => {
    const platform = platformById(platforms, id);
    const credential = credentials[id];
    const own = entries.filter(entry => entry.credentialId === id);
    const namedPlatform = platform && platform.id !== CUSTOM_PLATFORM_ID ? platform : undefined;
    const existing = own.find(entry => typeof entry.baseUrl === 'string' && entry.baseUrl.trim());
    return {
      id,
      platformId: namedPlatform ? namedPlatform.id : CUSTOM_PLATFORM_ID,
      label: namedPlatform ? namedPlatform.label : (credential?.displayName?.trim() || id),
      baseUrl: namedPlatform?.baseUrl.trim() || existing?.baseUrl?.trim() || '',
      api: (namedPlatform ?? existing)?.api ?? 'openai-completions',
      credentialRef: credential?.secretRef?.trim() || platform?.credentialRef || fallbackCredentialRef(id),
      modelCount: own.length,
    };
  });
}

export function draftFromModelVendor(vendor: ModelVendor): ProviderDraft {
  return {
    platformId: vendor.platformId,
    label: vendor.label,
    baseUrl: vendor.baseUrl,
    api: vendor.api,
    credentialId: vendor.id,
    credentialRef: vendor.credentialRef,
  };
}

export function shouldAutoProbe(selectedVendorId: string, previous: string | null | undefined): boolean {
  const next = selectedVendorId.trim();
  return next.length > 0 && next !== (previous ?? '');
}

export interface AutoProbeDecision {
  /** True when a probe request must go out now. */
  probe: boolean;
  /** What to remember as "already probed": the new id only after a request is
   * really issued, otherwise the previous value unchanged. */
  recorded: string | null;
}

export function autoProbeDecision(selectedVendorId: string, previous: string | null, baseUrl: string): AutoProbeDecision {
  if (!shouldAutoProbe(selectedVendorId, previous)) return { probe: false, recorded: previous };
  if (!baseUrl.trim()) return { probe: false, recorded: previous };
  return { probe: true, recorded: selectedVendorId.trim() };
}

export function probeFailureNote(message: string): string {
  const detail = message.trim() || '未知错误';
  return `模型列表获取失败（${detail}）；可手动添加模型 id。`;
}

export interface KeyEntryGuidance {
  mode: 'desktop' | 'browser';
  title: string;
  lines: readonly string[];
  /** Environment variable name the daemon resolves for this credential. */
  envVar: string;
  /** One-click-copyable shell line; the value stays a placeholder (no secret). */
  exportLine: string;
}

export function keyEntryGuidance(input: { hasBridge: boolean; credentialRef: string }): KeyEntryGuidance {
  const envVar = input.credentialRef.trim() || 'GRAPH_PROVIDER_API_KEY';
  const exportLine = `export ${envVar}=…`;
  if (input.hasBridge) {
    return {
      mode: 'desktop',
      title: 'API 密钥 / 订阅凭据',
      lines: ['在桌面 App 窗口里填写，保存后只写入系统钥匙串；密钥不会进入配置文件、接口响应或页面。'],
      envVar,
      exportLine,
    };
  }
  return {
    mode: 'browser',
    title: '浏览器模式没有密钥输入框',
    lines: [
      '当前是浏览器模式：浏览器无法访问系统钥匙串，所以这里没有密钥输入框，也不会把密钥发到服务端。',
      '用桌面 App 窗口打开同一地址，即可在「① 配置厂商」填写 API 密钥 / 订阅凭据并保存到钥匙串。',
      `或者先在运行环境里设置环境变量 ${envVar}，再回到这里点「保存并验证」。`,
    ],
    envVar,
    exportLine,
  };
}

export function platformsRequest(): { url: string } {
  return { url: PROVIDER_ROUTES.list };
}

export function probePayload(draft: ProviderDraft, requestId: string, modelId?: string) {
  return {
    requestId,
    provider: {
      id: draft.platformId,
      label: draft.label,
      baseUrl: draft.baseUrl.trim(),
      api: draft.api,
      credentialRef: draft.credentialRef,
    },
    ...(modelId ? { modelId } : {}),
  };
}

export function probeRequest(draft: ProviderDraft, requestId: string, modelId?: string): {
  url: string;
  init: { method: 'POST'; headers: Record<string, string>; body: string };
} {
  return {
    url: PROVIDER_ROUTES.probe,
    init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(probePayload(draft, requestId, modelId)) },
  };
}

export interface ProbeModel {
  id: string;
  name?: string;
}

export interface ModelPick {
  modelId: string;
  name?: string;
  selected: boolean;
  manual?: boolean;
}

export function mergeProbeModels(probe: readonly ProbeModel[], previous: readonly ModelPick[]): ModelPick[] {
  const merged: ModelPick[] = previous.map(pick => ({ ...pick }));
  const seen = new Set(merged.map(pick => pick.modelId));
  for (const model of probe) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push({ modelId: id, ...(model.name ? { name: model.name } : {}), selected: false });
  }
  return merged;
}

export function addManualModelPick(previous: readonly ModelPick[], modelId: string): ModelPick[] {
  const id = modelId.trim();
  if (!id || previous.some(pick => pick.modelId === id)) return previous.map(pick => ({ ...pick }));
  return [...previous.map(pick => ({ ...pick })), { modelId: id, selected: true, manual: true }];
}

export function selectedProbeModels(picks: readonly ModelPick[]): ModelPick[] {
  return picks.filter(pick => pick.selected);
}
