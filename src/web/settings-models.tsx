
import { ProviderIcon } from './ProviderPicker.tsx';


import { useState } from 'react';




import { Button,Card,Icon,Pill } from './ui.tsx';



import { MODEL_TIERS,modelTier,type ModelGrade,type ModelTier } from '../catalog/models.ts';



import {
hasRequiredModelFields,
type ProbeModel,
type SnapshotMetadata
} from './provider-form.ts';

import type { RawConfig } from "./settings-config.tsx";
import { ccSwitchCost,findCcSwitchPrice,loadCcSwitchPricing } from "./settings-config.tsx";

export function ConfiguredModelsPanel({ draft, credentialState, mutate, onManage, onEdit }: {
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

export function ConfiguredProvidersPanel({ draft, credentialState, onEdit, onDelete }: {
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

export interface SettingsSection {
  id: string;
  label: string;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: 'settings-overview', label: '常规' },
  { id: 'settings-archived', label: '归档对话' },
];

export type ProbeResponse = {
  models?: { id?: unknown; name?: unknown }[];
  modelsError?: unknown;
  credentialConfigured?: unknown;
  verification?: { ok?: unknown; error?: unknown; skipped?: unknown };
};

export function probeModelsFrom(response: ProbeResponse): ProbeModel[] {
  const list = Array.isArray(response.models) ? response.models : [];
  const models: ProbeModel[] = [];
  for (const item of list) {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    if (!id) continue;
    models.push({ id, ...(typeof item.name === 'string' && item.name.trim() ? { name: item.name.trim() } : {}) });
  }
  return models;
}

export type ModelsDevModule = typeof import('../catalog/models-dev.ts');

export let modelsDevModule: Promise<ModelsDevModule> | null = null;

export function loadModelsDev(): Promise<ModelsDevModule> {
  return import('../catalog/models-dev.ts');
}

export async function lookupSnapshot(providerId: string, modelId: string): Promise<SnapshotMetadata | null> {
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
