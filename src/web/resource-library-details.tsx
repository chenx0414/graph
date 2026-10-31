

import { useState } from 'react';



import { Button,Empty,Pill,toast } from './ui.tsx';


import type { CapabilityRecord } from './catalog-view-types.ts';


import './setup.ts';

import type { CapabilityConfigItem,ExtensionUpdate,LibraryEntryFilter } from "./resource-library-entries.tsx";
import { capabilityConfigItemGuidance,capabilityConfigItemIsConfigured,capabilityKindLabel,LIBRARY_FILTERS,splitLibraryEntries } from "./resource-library-entries.tsx";
import './resource-library.css';

export function CapabilityDetail({ item, update, onUpdate }: { item: CapabilityRecord; update?: ExtensionUpdate | undefined; onUpdate?: ((item: CapabilityRecord) => void) | undefined }) {
  return (
    <div className="stack resource-detail-sections" data-testid={`capability-detail-${item.id}`}>
      <div className="row" style={{ gap: 8 }}>
        <Pill tone={item.status === 'available' ? 'success' : 'danger'}>{item.status === 'available' ? '可用' : '清单有误'}</Pill>
        <Pill tone="neutral">{capabilityKindLabel(item)}</Pill>
        <Pill tone="neutral">v{item.version}</Pill>
        {item.base && <Pill tone="success">基础能力</Pill>}
      </div>
      <p>{item.description || '该能力没有提供说明。'}</p>
      {item.base && <p className="muted" data-testid={`capability-base-${item.id}`}>基础能力：每个 Agent 都会自动获得，无需在配方里绑定。</p>}
      {item.owner && <p className="muted" data-testid={`capability-owner-${item.id}`}>来自 {item.owner} 的 skills 文件夹</p>}
      {item.duplicates?.length ? (
        <p className="muted" data-testid={`capability-duplicates-${item.id}`}>
          另有 {item.duplicates.length} 个同名副本（同名只加载一个）：{item.duplicates.map(dup => dup.source).join('、')}
        </p>
      ) : null}
      {item.note && <div className="recipe-main-note" data-testid={`capability-note-${item.id}`}>{item.note}</div>}
      {item.packageSource && (
        <p className="muted" data-testid={`capability-package-source-${item.id}`}>来源：{item.packageSource}（由 Pi SDK 解析安装）</p>
      )}
      {update?.installGaps?.length ? (
        <p className="muted" data-testid={`capability-install-gaps-${item.id}`}>
          安装根里有声明的入口缺失（只报告，不做任何处理）：{update.installGaps.join('；')}
        </p>
      ) : null}
      {update?.available && (
        <div className="recipe-main-note" data-testid={`capability-update-${item.id}`}>
          <span>有可用更新：已安装 {update.installed} → {update.latest}</span>
          <Button onClick={() => onUpdate?.(item)}>更新</Button>
        </div>
      )}
      {item.error && <div className="form-error">{item.error}</div>}
      <section>
        <h4>本地目录</h4>
        <code className="resource-path">{item.source}</code>
      </section>
      <section>
        <h4>使用边界</h4>
        <p className="muted">扫描到正确目录后即可直接使用。能力本身不会授予任务权限，实际运行仍受任务范围、暂停和调用门约束。</p>
      </section>
    </div>
  );
}

export function CapabilityConfigPanel({ items, filter, onFilterChange }: { items: CapabilityConfigItem[]; filter: LibraryEntryFilter; onFilterChange(filter: LibraryEntryFilter): void }) {
  const bridge = typeof window !== 'undefined' ? window.graph : undefined;
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string; tools?: string[] }>>({});
  if (!items.length) return <Empty icon="settings" title="暂无需要配置的能力" hint="需要凭据或环境变量的 MCP 会显示在这里。" />;
  const saveAndTest = async (item: CapabilityConfigItem) => {
    const key = `${item.id}@${item.version}`;
    setBusy(key);
    try {
      const supplied = Object.fromEntries(item.fields.flatMap(field => {
        const value = values[`${key}:${field.env}`]?.trim();
        return value ? [[field.env, value]] : [];
      }));
      if (bridge) {
        for (const [ref, value] of Object.entries(supplied)) {
          const saved = await bridge.saveSecret(ref, value);
          if (!saved.stored && !saved.applied) throw new Error(saved.message ?? `无法保存 ${ref}`);
        }
        window.dispatchEvent(new Event('graph:settings-changed'));
      }
      setResults(current => ({ ...current, [key]: { ok: true, message: '已保存。MCP 连接由内核在会话内建立。' } }));
      toast(`${item.name} 凭据已保存`, 'success');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setResults(current => ({ ...current, [key]: { ok: false, message } }));
      toast(message, 'danger');
    } finally {
      setBusy(null);
    }
  };
  const split = splitLibraryEntries(items, filter, capabilityConfigItemIsConfigured);
  const renderConfigItem = (item: CapabilityConfigItem) => {
    const key = `${item.id}@${item.version}`;
    const result = results[key];
    return (
      <article className="capability-config-item" key={key} data-testid={`capability-config-${item.id}`}>
            <header>
              <div><strong>{item.name}</strong><code>{item.id}@{item.version}</code></div>
              <Pill tone={item.ready ? 'success' : item.missing.length ? 'warn' : 'danger'}>
                {item.error ? '清单不可读' : item.ready ? '已配置' : `缺少 ${item.missing.length} 项`}
              </Pill>
            </header>
            {item.error && <div className="form-error">{item.error}</div>}
            <div className="capability-config-fields">
              {item.fields.map(field => {
                const configured = item.configured.includes(field.env);
                return (
                  <label className="capability-config-field" key={field.env}>
                    <span><strong>{field.label}</strong><code>{field.env}</code></span>
                    <input
                      className="input"
                      type={field.secret ? 'password' : 'text'}
                      autoComplete="off"
                      placeholder={configured ? '已保存，留空则保持不变' : field.env}
                      value={values[`${key}:${field.env}`] ?? ''}
                      data-testid={`capability-config-${item.id}-${field.env}`}
                      onChange={event => setValues(current => ({ ...current, [`${key}:${field.env}`]: event.target.value }))}
                    />
                    <small>{field.reason}{configured ? ' · 已配置' : ''}</small>
                  </label>
                );
              })}
            </div>
            <div className="capability-config-actions">
              <span className="muted">{bridge ? '保存到本机钥匙串；连接由内核在会话内验证。' : '浏览器模式：请先设置对应环境变量。'}</span>
              <Button size="sm" icon="check" disabled={busy === key} onClick={() => void saveAndTest(item)}>
                {busy === key ? '保存中…' : '保存凭据'}
              </Button>
            </div>
            {result && (
              <div className={result.ok ? 'capability-config-result is-ok' : 'capability-config-result is-error'} data-testid={`capability-config-result-${item.id}`}>
                {result.message}
              </div>
            )}
          </article>
        );
  };
  const showConfigured = filter !== 'unconfigured';
  const showUnconfigured = filter !== 'configured';
  return (
    <div className="capability-config-list" data-testid="capability-config-list">
      <div className="resource-split-toggle" role="group" aria-label="按配置状态筛选" data-testid="resource-filter-config">
        {LIBRARY_FILTERS.map(option => (
          <button key={option.id} type="button" className="resource-split-option" data-active={option.id === filter} data-testid={`resource-filter-config-${option.id}`} onClick={() => onFilterChange(option.id)}>
            {option.label}
            <span className="resource-split-count">{option.id === 'all' ? split.counts.all : option.id === 'configured' ? split.counts.configured : split.counts.unconfigured}</span>
          </button>
        ))}
      </div>
      <div className="resource-groups">
        {showUnconfigured && (
          <section className="resource-group" data-testid="capability-config-group-unconfigured">
            <h4 className="resource-group-head"><span>未配置</span><span className="resource-group-count">{split.counts.unconfigured}</span></h4>
            {split.unconfigured.length
              ? split.unconfigured.map(item => (
                <div className="resource-candidate-wrap" key={`${item.id}@${item.version}`}>
                  {renderConfigItem(item)}
                  <p className="resource-config-guidance" data-testid={`capability-config-guidance-${item.id}`}>{capabilityConfigItemGuidance(item)}</p>
                </div>
              ))
              : <p className="muted resource-group-empty">没有未配置的能力。</p>}
          </section>
        )}
        {showConfigured && (
          <section className="resource-group" data-testid="capability-config-group-configured">
            <h4 className="resource-group-head"><span>已配置</span><span className="resource-group-count">{split.counts.configured}</span></h4>
            {split.configured.length
              ? split.configured.map(renderConfigItem)
              : <p className="muted resource-group-empty">没有已配置的能力。</p>}
          </section>
        )}
      </div>
    </div>
  );
}
