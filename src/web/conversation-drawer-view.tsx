import { api } from './api.ts';
import './conversation-drawer.css';
import {
DRAWER_ENTRY_LINKS,
drawerPanelIds
} from './conversation-drawer.ts';
import { DraftVersionToc } from "./conversation-graph.tsx";
import { useConversationPanelState } from "./conversation-state.tsx";
import { residentFlag } from "./conversation-types.tsx";
import { formatTokens } from './insights.ts';
import { TaskDrawerSection } from './TaskDrawerSection.tsx';
import { Button,Icon,Pill,Spinner } from './ui.tsx';

export function ConversationDrawerView({ drawerOpen, drawerSection, proposal, view, deferredInitPanelIds, bindId, setBindId, settings, act, id, activeProposal, activeStale, activeAccepted, confirmableForActive, branch, setBranch, setSelectedProposalVersion, selectedProposalVersion, proposalHistory, managementCards, drawerLoading, tasks, graphTasks, selectedTaskId, setSelectedTaskId, hasDrawerContent }: Pick<Extract<ReturnType<typeof useConversationPanelState>, { fallback: null }>, "drawerOpen" | "drawerSection" | "proposal" | "view" | "deferredInitPanelIds" | "bindId" | "setBindId" | "settings" | "act" | "id" | "activeProposal" | "activeStale" | "activeAccepted" | "confirmableForActive" | "branch" | "setBranch" | "setSelectedProposalVersion" | "selectedProposalVersion" | "proposalHistory" | "managementCards" | "drawerLoading" | "tasks" | "graphTasks" | "selectedTaskId" | "setSelectedTaskId" | "hasDrawerContent">) {
const projectScope = view.projectId ? [view.projectId, `conversation:${id}`] : [];
const scopedGraphs = (graphTasks ?? []).filter((task: { projectId?: string }) => projectScope.includes(String(task.projectId)));
const drawerTasks = scopedGraphs.length ? scopedGraphs : tasks;
return <aside
          id="conversation-detail-drawer"
          className="detail-drawer"
          data-testid="detail-drawer"
          data-open={drawerOpen}
          data-section={drawerSection}
          data-page={drawerSection === 'draft' ? 'card' : 'task'}
          data-drawer-panels={drawerPanelIds().join(' ')}
          aria-hidden={!drawerOpen}
          inert={!drawerOpen}
        >
          <div className="drawer-inner">
            {drawerSection === 'draft' && <div className="drawer-head"><div className="grow"><h2>{`草稿 v${proposal?.version ?? ""}`}</h2></div></div>}

            {drawerOpen && !view.projectId && view.role !== 'global' && deferredInitPanelIds.includes('bind-project') && (
              <section className="drawer-section drawer-bind-card" data-testid="bind-project" data-panel="bind-project">
                <div className="drawer-section-head">
                  <h3>绑定项目</h3>
                </div>
                <p className="muted">未绑定项目时主 Agent 无法读取代码；可以先聊天再选择项目。</p>
                <div className="thread-card-actions">
                  <select className="select" style={{ width: 220 }} data-testid="bind-select" value={bindId} onChange={event => setBindId(event.target.value)}>
                    <option value="">选择项目…</option>
                    {(settings?.projects ?? []).map(project => <option key={project.id} value={project.id}>{project.id}</option>)}
                  </select>
                  <Button size="sm" data-testid="bind-submit" disabled={!bindId} onClick={() => void act(() => api(`/api/conversations/${id}/bind`, { method: 'POST', body: JSON.stringify({ projectId: bindId, requestId: crypto.randomUUID() }) }))}>绑定</Button>
                </div>
              </section>
            )}

            {drawerOpen && view.role === 'global' && (
              <section className="drawer-section drawer-bind-card" data-testid="bound-source">
                <div className="drawer-section-head">
                  <h3>固定绑定</h3>
                </div>
                <p className="muted">主 Agent 的读写范围固定在这个仓库，不能改绑其他项目。</p>
                <code className="mono" data-testid="bound-source-root">{view.sourceRoot ?? '未知'}</code>
              </section>
            )}

            {drawerOpen && drawerSection === 'draft' && activeProposal && (
              <section className="drawer-section drawer-draft-card" data-testid="proposal-draft" data-resident={residentFlag('proposal-draft')}>
                <div className="drawer-draft-head">
                      <div className="grow">
                        <div className="drawer-draft-title">草稿 v{activeProposal.version}</div>
                        <div className="drawer-draft-summary" data-testid="drawer-draft-summary">{activeProposal.spec.summary}</div>
                      </div>
                      <Pill tone={activeStale ? 'warn' : activeAccepted ? 'success' : 'info'}>
                        {activeAccepted ? `已确认草稿 v${activeProposal.version}` : activeStale ? '需重新讨论' : '待确认'}
                      </Pill>
                    </div>
                    {activeStale && <p data-testid="draft-stale" className="muted">需求已变化，这个草稿不能执行；请让主 Agent 针对最新需求重新提案。</p>}
                    {activeAccepted && <p data-testid="draft-accepted" className="muted">已确认草稿 v{activeProposal.version}，执行状态见任务导航。</p>}
                    {confirmableForActive && !view.projectId && <p data-testid="draft-needs-project" className="muted">确认前需要先绑定项目。</p>}
                    {confirmableForActive && view.projectId && (
                      <>
                        <p data-testid="draft-budget" className="muted" style={{ fontSize: 12 }}>
                          主管已用 {formatTokens(view.master?.used ?? 0)} tokens。
                        </p>
                        <div className="thread-card-actions">
                          <label className="row" style={{ gap: 6 }}>
                            <span className="muted">目标分支</span>
                            <input className="input" style={{ width: 150, maxWidth: 150 }} data-testid="accept-branch" data-resident={residentFlag('accept-branch')} value={branch} onChange={event => setBranch(event.target.value)} />
                          </label>
                          <Button variant="primary" icon="check" data-testid="confirm-draft" data-resident={residentFlag('confirm-draft')} onClick={() => void act(() => api(`/api/conversations/${id}/confirm`, { method: 'POST', body: JSON.stringify({ proposalVersion: activeProposal.version, draftRevision: activeProposal.draftRevision, targetBranch: branch, requestId: `confirm-${crypto.randomUUID()}` }) }))}>确认草稿并开始执行</Button>
                        </div>
                      </>
                    )}
                {/* The drawer names the windows; it does not render them. */}
                <div className="drawer-entry-links" data-testid="drawer-entry-links">
                  {DRAWER_ENTRY_LINKS.map(entry => (
                    <a
                      key={entry.id}
                      className="btn btn-sm"
                      data-testid={`drawer-entry-${entry.id}`}
                      href={`#/conversations/${id}/graph?v=${selectedProposalVersion ?? activeProposal.version}`}
                    >
                      <Icon name={entry.id === 'graph' ? 'graph' : 'box'} size={14} />
                      <span style={{ marginLeft: 6 }}>{entry.label}</span>
                    </a>
                  ))}
                </div>
              </section>
            )}
            {drawerOpen && (proposalHistory.length > 0 || (view.archivedProposals ?? []).length > 0) && (
              <section className="drawer-section" data-testid="draft-cards">
                {proposalHistory.length > 0 && <DraftVersionToc history={proposalHistory} selectedVersion={selectedProposalVersion ?? proposal?.version ?? null} onSelectVersion={setSelectedProposalVersion} />}
                {/* The confirmed history is managed here, not only on the draft page:
                    a conversation whose every card is confirmed has no draft page to
                    open, so this list is the entry that keeps those cards manageable
                    without touching the task or its graph. The card already managed
                    above (the active draft) is left out to avoid two copies. */}
                {managementCards.length > 0 && (
                  <div data-testid="active-drafts">
                    {managementCards.map(item => (
                      <div key={item.version} className="row" data-testid={`active-draft-${item.version}`}>
                        <span className="grow">{`v${item.version}${item.accepted ? ' 已确认' : ' 待确认'} · ${item.summary}`}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}
            {drawerOpen && drawerSection === 'draft' && drawerLoading && (
              <div className="drawer-loading"><Spinner label="正在加载草稿…" /></div>
            )}

            {drawerOpen && <TaskDrawerSection tasks={drawerTasks} selectedId={selectedTaskId} onSelect={setSelectedTaskId} origin="conversation" />}

            {drawerOpen && !hasDrawerContent && !drawerLoading && (
              <div className="drawer-empty" data-testid="detail-empty">
                <strong>暂无详情</strong>
                <span>出现草稿详情或执行进度后，详情会显示在这里。</span>
              </div>
            )}
          </div>
        </aside>;
}
