
import { ArchitectureBoard } from './ArchitectureBoard.tsx';




import { createPortal } from 'react-dom';




import { Button,Card,Empty,Icon,Pill,toast } from './ui.tsx';








import './setup.ts';


import { CapabilityConfigPanel,CapabilityDetail } from "./resource-library-details.tsx";

import { AgentCombinationEditor } from "./resource-library-editor.tsx";


import { capabilityConfigGuidance,capabilityGroups,LIBRARY_FILTERS,MAIN_AGENT_SYSTEM_CAPABILITIES } from "./resource-library-entries.tsx";

import { useResourceLibraryState } from "./resource-library-state.tsx";
import './resource-library.css';

export function ResourceLibraryView({ openResource, sections, active, countFor, setEditing, refresh, settings, agentCombinations, resourceQuery, setResourceQuery, filteredAgents, visibleAgents, openResolvedCapability, remove, libraryFilter, setLibraryFilter, autoUpdate, saveAutoUpdate, filtered, toggleBrowse, browseOpen, browseQuery, setBrowseQuery, loadBrowse, browseBusy, browseError, browseHits, split, showConfigured, configuredVisible, setSelected, showUnconfigured, unconfiguredVisible, configFor, shownCount, setResourceLimits, selected, updates, updateOne, editing, capabilities, reloadExtensions, Event }: Extract<ReturnType<typeof useResourceLibraryState>, { fallback: null }>) {
return (
    <div className="stagger resource-library" data-testid="catalog">
      <div className="resource-layout">
        <nav className="resource-nav" aria-label="资源库导航">
          {sections.map(item => <a key={item.id} href={`#/catalog/${item.id}`} data-active={item.id === active.id} data-testid={`resource-nav-${item.id}`}><Icon name={item.icon} size={15} /><span>{item.title}</span><span className="resource-nav-count">{countFor(item.id)}</span></a>)}
        </nav>
        <section className="resource-main">
          <Card
            testid={`resource-section-${active.id}`}
            title={active.title}
            icon={active.icon}
            subtitle={`${countFor(active.id)} 项`}
            actions={(
              <div className="row" style={{ gap: 4 }}>
                {active.id === 'agents' && <button type="button" className="icon-button" onClick={() => setEditing(null)} title="新建 Agent 配方" aria-label="新建 Agent 配方"><Icon name="plus" size={16} /></button>}
                {(active.id === 'mcp' || active.id === 'pi-extensions') && <button type="button" className="btn btn-sm" data-testid="resource-reload-extensions" onClick={reloadExtensions} title="重载扩展宿主：装好的扩展或 MCP 服务器从下一次会话起生效">重载扩展</button>}
                <button type="button" className="icon-button" onClick={refresh} title="重新扫描能力目录" aria-label="重新扫描能力目录"><Icon name="refresh" size={16} /></button>
                {active.id !== 'agents' && active.id !== 'architectures' && active.id !== 'config' && <button type="button" className="icon-button" data-testid={`resource-open-${active.id}`} onClick={() => void openResource(active.id as 'skills' | 'mcp' | 'pi-extensions' | 'agent-md' | 'prompts')} title="在访达中打开目录" aria-label="在访达中打开目录"><Icon name="folder" size={16} /></button>}
              </div>
            )}
          >
            {active.id === 'agents' ? (
              settings?.agentCombinationError ? <div className="form-error">配方文件无法读取：{settings.agentCombinationError}</div>
              : agentCombinations.length ? (
                <>
                  <div className="resource-section-toolbar"><p>{active.description}</p><label className="resource-search"><Icon name="search" size={15} /><input value={resourceQuery} onChange={event => setResourceQuery(event.target.value)} placeholder="搜索 Agent 配方或能力" /><span className="faint">{filteredAgents.length}</span></label></div>
                  <div className="agent-combination-list" data-testid="agent-combination-list">
                    {visibleAgents.map(item => (
                      <article className="agent-combination-item" key={item.id} data-testid={`agent-combination-${item.id}`}>
                        <header>
                          <div className="agent-combination-title">
                            <strong>{item.name}</strong>
                            <span>Agent 配方{item.tags.length ? ` · ${item.tags.join(' · ')}` : ''}</span>
                          </div>
                          <code>{item.id}</code>
                        </header>
                        <p className="agent-combination-description">
                          <Icon name="message" size={13} />
                          <span>{item.description}</span>
                        </p>
                        <div className="chip-row">
                          <Pill tone={item.status === 'valid' ? 'success' : 'danger'}>{item.status === 'valid' ? '可编译' : '引用有误'}</Pill>
                          {item.mode === 'main' && <Pill tone="accent">Main Agent</Pill>}
                          {item.review && <Pill tone="warn">独立审查</Pill>}
                        </div>
                        {item.mode === 'main' && (
                          <section className="recipe-capability-group" data-testid="main-agent-system-capabilities">
                            <h4>系统能力</h4>
                            <div className="chip-row">
                              {MAIN_AGENT_SYSTEM_CAPABILITIES.map(capability => <span className="capability-chip" key={capability}>{capability}</span>)}
                            </div>
                          </section>
                        )}
                        <div className="recipe-capability-groups">
                          {capabilityGroups(item).map(group => (
                            <section className="recipe-capability-group" key={group.id} data-testid={`agent-capabilities-${item.id}-${group.id}`}>
                              <h4>{group.label}</h4>
                              <div className="chip-row">
                                {group.resources.map(resource => (
                                  <button
                                    key={`${resource.role}:${resource.resourceId}:${resource.version}`}
                                    type="button"
                                    className="capability-chip"
                                    data-testid={`agent-capability-${item.id}-${resource.resourceId}`}
                                    onClick={() => openResolvedCapability(resource.resourceId, resource.version)}
                                  >
                                    {resource.name}
                                  </button>
                                ))}
                              </div>
                            </section>
                          ))}
                        </div>
                        {item.issues.map(issue => <div className="form-error" key={issue}>{issue}</div>)}
                        <div className="recipe-card-actions">
                          <Button size="sm" variant="ghost" onClick={() => setEditing(item)}>编辑</Button>
                          <Button size="sm" variant="danger" disabled={item.mode === 'main'} onClick={() => void remove(item.id)}>删除</Button>
                        </div>
                      </article>
                    ))}
                  </div>
                </>
              ) : <Empty icon="catalog" title="暂无 Agent 配方" hint="点击右上角 + 创建配方。" />
            ) : active.id === 'prompts' ? (
              <div className="prompt-library-summary" data-testid="prompt-library-summary">
                <p>{active.description} 对话顶部的“Agent 上下文”可以直接查看和编辑；这里可以打开固定文件夹做批量维护。</p>
                <Button size="sm" icon="folder" onClick={() => void openResource('prompts')}>打开 Prompt 文件夹</Button>
              </div>
            ) : active.id === 'config' ? (
              <CapabilityConfigPanel items={settings?.capabilityConfig ?? []} filter={libraryFilter} onFilterChange={setLibraryFilter} />
            ) : active.id === 'architectures' ? (
              <ArchitectureBoard />
            ) : active.items.length ? (
              <>
                <div className="resource-section-toolbar"><p>{active.description}</p>{active.id === 'pi-extensions' && (
                  <label className="preference-item" data-testid="pi-extension-auto-update">
                    <span className="preference-copy">
                      <strong>自动更新</strong>
                      <span className="muted">守护进程启动时安装可用的 Pi 扩展更新；关闭时只在资源库里提示。</span>
                    </span>
                    <input type="checkbox" className="preference-toggle" data-testid="pi-extension-auto-update-toggle" checked={autoUpdate} onChange={event => void saveAutoUpdate(event.target.checked)} />
                  </label>
                )}<label className="resource-search"><Icon name="search" size={15} /><input value={resourceQuery} onChange={event => setResourceQuery(event.target.value)} placeholder="搜索能力或路径" data-testid="resource-catalog-search" /><span className="faint">{filtered.length}</span></label></div>
                {active.id === 'pi-extensions' && (
                  <div className="browse-official" data-testid="pi-package-browser">
                    <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <Button onClick={() => void toggleBrowse()}>{browseOpen ? '收起官方扩展库' : '浏览官方扩展库'}</Button>
                      <span className="muted">官方渠道是 npm（关键字 pi-package）；这里只浏览，加入请让主 Agent 来做</span>
                    </div>
                    {browseOpen && (
                      <div className="stack" style={{ gap: 8, marginTop: 8 }}>
                        <div className="row" style={{ gap: 8 }}>
                          <input value={browseQuery} onChange={event => setBrowseQuery(event.target.value)} placeholder="搜索官方 Pi 包（名称或关键字；留空看最新）" data-testid="pi-package-query" style={{ flex: 1 }} />
                          <Button onClick={() => void loadBrowse()} disabled={browseBusy}>{browseBusy ? '检索中…' : '搜索'}</Button>
                        </div>
                        {browseError && <p className="form-error" data-testid="pi-package-error">{browseError}</p>}
                        {!browseBusy && !browseError && !browseHits.length && <p className="muted" data-testid="pi-package-empty">没有匹配的 Pi 包。</p>}
                        {browseHits.length > 0 && (
                          <ul className="stack" style={{ gap: 6, listStyle: 'none', padding: 0, margin: 0 }} data-testid="pi-package-results">
                            {browseHits.map(hit => (
                              <li key={hit.name} className="resource-candidate-copy" data-testid={`pi-package-${hit.name}`} style={{ padding: '6px 0' }}>
                                <span><strong>{hit.name}</strong> <span className="faint">v{hit.version}</span>{hit.weeklyDownloads !== null ? <span className="faint"> · 周下载 {hit.weeklyDownloads}</span> : null}{hit.publisher ? <span className="faint"> · {hit.publisher}</span> : null}</span>
                                <small>{hit.description}</small>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                )}
                <div className="resource-split-toggle" role="group" aria-label="按配置状态筛选" data-testid={`resource-filter-${active.id}`}>
                  {LIBRARY_FILTERS.map(option => (
                    <button
                      key={option.id}
                      type="button"
                      className="resource-split-option"
                      data-active={option.id === libraryFilter}
                      data-testid={`resource-filter-${active.id}-${option.id}`}
                      onClick={() => setLibraryFilter(option.id)}
                    >
                      {option.label}
                      <span className="resource-split-count">{option.id === 'all' ? split.counts.all : option.id === 'configured' ? split.counts.configured : split.counts.unconfigured}</span>
                    </button>
                  ))}
                </div>
                {filtered.length ? (
                  <div className="resource-groups">
                    {showConfigured && (
                      <section className="resource-group" data-testid={`resource-group-${active.id}-configured`}>
                        <h4 className="resource-group-head"><span>已配置</span><span className="resource-group-count">{split.counts.configured}</span></h4>
                        {configuredVisible.length
                          ? <div className="resource-candidate-list">{configuredVisible.map(item => <button key={`${item.id}@${item.version}`} type="button" className="resource-candidate-row" data-testid={`resource-entry-${item.id}`} onClick={() => setSelected(item)}><Icon name={active.icon} size={15} /><span className="resource-candidate-copy"><span>{item.name ?? item.id}</span><small>{item.status === 'invalid' ? item.error : item.description || item.source}</small></span><Icon name="chevron" size={14} /></button>)}</div>
                          : <p className="muted resource-group-empty">没有匹配的已配置能力。</p>}
                      </section>
                    )}
                    {showUnconfigured && (
                      <section className="resource-group" data-testid={`resource-group-${active.id}-unconfigured`}>
                        <h4 className="resource-group-head"><span>未配置</span><span className="resource-group-count">{split.counts.unconfigured}</span></h4>
                        {unconfiguredVisible.length
                          ? <div className="resource-candidate-list">{unconfiguredVisible.map(item => (
                            <div className="resource-candidate-wrap" key={`${item.id}@${item.version}`}>
                              <button type="button" className="resource-candidate-row" data-testid={`resource-entry-${item.id}`} onClick={() => setSelected(item)}><Icon name={active.icon} size={15} /><span className="resource-candidate-copy"><span>{item.name ?? item.id}</span><small>{item.status === 'invalid' ? item.error : item.description || item.source}</small></span><Icon name="chevron" size={14} /></button>
                              <p className="resource-config-guidance" data-testid={`resource-guidance-${item.id}`}>{capabilityConfigGuidance(item, configFor(item))}</p>
                            </div>
                          ))}</div>
                          : <p className="muted resource-group-empty">没有匹配的未配置能力。</p>}
                      </section>
                    )}
                  </div>
                ) : <p className="muted">没有匹配的能力。</p>}
                {split.visible.length > shownCount && <Button size="sm" data-testid={`resource-more-${active.id}`} onClick={() => setResourceLimits(current => ({ ...current, [active.id]: (current[active.id] ?? 40) + 40 }))}>显示更多（{shownCount} / {split.visible.length}）</Button>}
              </>
            ) : <p className="muted">{active.id === 'agent-md' ? '暂无 Agent.md 能力' : `暂无 ${active.title.replace(' 库', '')} 能力`}</p>}
          </Card>
        </section>
      </div>
      {selected && createPortal(
        <div className="resource-detail-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setSelected(null); }}>
          <aside className="resource-detail-drawer" data-testid="resource-detail-drawer" role="dialog" aria-modal="true" aria-label={`能力详情 ${selected.name ?? selected.id}`}>
            <header className="resource-detail-head"><div><h2>{selected.name ?? selected.id}</h2><p>能力详情</p></div><button type="button" className="icon-button" data-testid="resource-detail-close" onClick={() => setSelected(null)} aria-label="关闭详情"><Icon name="close" size={16} /></button></header>
            <div className="resource-detail-body"><CapabilityDetail item={selected} update={updates[`${selected.id}@${selected.version}`]} onUpdate={item => void updateOne(item)} /></div>
          </aside>
        </div>,
        document.body,
      )}
      {editing !== undefined && (
        <AgentCombinationEditor
          capabilities={capabilities}
          combinations={agentCombinations}
          {...(editing ? { initial: editing } : {})}
          onClose={() => setEditing(undefined)}
          onDescriptionSaved={() => window.dispatchEvent(new Event('graph:settings-changed'))}
          onSaved={result => {
            setEditing(undefined);
            window.dispatchEvent(new Event('graph:settings-changed'));
            if (result.compileError) toast(`配方已保存，但编译失败：${result.compileError}`, 'danger');
            else if (result.definition) toast(`配方已保存，已编译为 ${result.definition.definitionVersion}`, 'success');
            else toast('配方已保存', 'success');
          }}
        />
      )}
    </div>
  );
}
