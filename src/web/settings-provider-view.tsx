import { ProviderCredentialsView } from "./settings-credentials-view.tsx";






import { Setup } from './Setup.tsx';

import { Button,Card,Field,Pill } from './ui.tsx';




import { defaultThinkingLevelFor } from '../catalog/models.ts';

import { nearestLevel,thinkingOptionLabel } from './thinking-levels.ts';

import {
completeCost,
modelFieldErrors,
withCostField
} from './provider-form.ts';

import type { ModelThinkingLevel } from "./settings-config.tsx";
import { useProviderWorkbenchState } from "./settings-provider-state.tsx";

export function ProviderWorkbenchView({ platforms, platformId, choosePlatform, busy, selected, platformsNote, isCustom, fieldError, mark, custom, setCustom, active, editAccount, draft, setKey, resolved, setKeyResolved, onCredentialStored, setPlatforms, bridge, keyGuidance, key, copyExportLine, limitIds, concurrency, setConcurrency, saveProvider, verification, selectedVendor, vendorBlockedReason, vendorDraft, runProbe, picks, addSelected, selectedVendorId, vendors, setSelectedVendorId, requiredProblems, note, probeModels, manualRows, setPicks, manualId, setManualId, addManual, vendorEntries, entries, mutate, Number, openGuide }: Extract<ReturnType<typeof useProviderWorkbenchState>, { fallback: null }>) {
return (
    <>
      <ProviderCredentialsView {...{ platforms, platformId, choosePlatform, busy, selected, platformsNote, isCustom, fieldError, mark, custom, setCustom, active, editAccount, draft, setKey, resolved, setKeyResolved, onCredentialStored, setPlatforms, bridge, keyGuidance, key, copyExportLine, limitIds, concurrency, setConcurrency, saveProvider, verification }} />

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
