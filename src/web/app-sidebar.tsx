







import { useState } from 'react';

import { api } from './api.ts';






import { CreateProjectDialog } from './CreateProjectDialog.tsx';



import { type ConversationSummary } from './Conversation.tsx';





import { Icon,toast } from './ui.tsx';



import type { Settings_ } from "./app-state.tsx";

export function Sidebar({ path, settings, conversations, onSettingsChanged }: {
  path: string;
  settings: Settings_ | null;
  conversations: ConversationSummary[];
  onSettingsChanged: () => void;
}) {
  const [sections, setSections] = useState({ projects: true, recent: true });
  const [createProject, setCreateProject] = useState(false);
  const [archiving, setArchiving] = useState('');
  const [openingProject, setOpeningProject] = useState('');
  const ordered = [...conversations].sort((left, right) => (right.updatedAt ?? right.createdAt) - (left.updatedAt ?? left.createdAt));
  const global = ordered.find(conversation => 'role' in conversation && conversation.role === 'global');
  // An archived project is put away: its rows leave the project list, and the
  // settings page is where it comes back from.
  const projectRows = settings?.projects ?? [];
  const activeProjects = projectRows.filter(project => project.archivedAt == null);
  const archivedProjects = projectRows.filter(project => project.archivedAt != null);
  // The project rows no longer list their conversations, so every conversation that is
  // not a supervisor thread stays reachable from the recent list instead.
  const unbound = ordered.filter(conversation => !('role' in conversation && (conversation.role === 'global' || conversation.role === 'project')));
  function isSupervisor(conversation: ConversationSummary) {
    return 'role' in conversation && (conversation.role === 'global' || conversation.role === 'project');
  }
  async function openProjectThread(projectId: string, knownConversationId?: string) {
    if (openingProject) return;
    if (knownConversationId) {
      location.hash = `#/conversations/${knownConversationId}`;
      return;
    }
    setOpeningProject(projectId);
    try {
      const thread = await api<{ conversationId: string }>(`/api/projects/${encodeURIComponent(projectId)}/thread`, {
        method: 'POST', body: JSON.stringify({ requestId: `open-${crypto.randomUUID()}` }),
      });
      window.dispatchEvent(new Event('graph:conversations-changed'));
      location.hash = `#/conversations/${thread.conversationId}`;
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : String(reason), 'danger');
    } finally {
      setOpeningProject('');
    }
  }
  async function archiveConversation(conversation: ConversationSummary) {
    if (archiving) return;
    setArchiving(conversation.id);
    try {
      await api(`/api/conversations/${conversation.id}/archive`, {
        method: 'POST',
        body: JSON.stringify({ requestId: `archive-${crypto.randomUUID()}` }),
      });
      toast('对话已归档，可在设置的“归档对话”中恢复。', 'success');
      window.dispatchEvent(new Event('graph:conversations-changed'));
      if (path === `/conversations/${conversation.id}`) location.hash = '#/';
    } catch (reason) {
      toast(`归档失败：${reason instanceof Error ? reason.message : String(reason)}`, 'danger');
    } finally {
      setArchiving('');
    }
  }
  return (
    <>
      <div className="sidebar-scroll" data-testid="conversation-list">
        <div className="sidebar-label">主 Agent</div>
        <div className="sidebar-section">
          {global ? <SidebarConversation conversation={global} active={path === `/conversations/${global.id}`} archiving={false} onArchive={() => {}} canArchive={false} /> : (
            <a className="sidebar-conversation" href="#/" data-testid="open-global-agent"><Icon name="message" size={14} /><span>与主 Agent 对话</span></a>
          )}
        </div>
        <div className="sidebar-label">
          <button type="button" className="sidebar-section-toggle" aria-expanded={sections.projects} onClick={() => setSections(value => ({ ...value, projects: !value.projects }))}><Icon name="chevron" size={12} /><span>项目</span></button>
          <button type="button" className="sidebar-add" data-testid="project-create-open" onClick={() => setCreateProject(true)} aria-label="新建项目" title="新建项目">
            <Icon name="plus" size={15} />
          </button>
        </div>
        <div className="sidebar-section" hidden={!sections.projects}>
          {activeProjects.map(project => {
            // One project means one supervisor Agent, so the row itself is the
            // way in: no second button to find and no list to open first.
            const supervisor = ordered.find(conversation => conversation.projectId === project.id && 'role' in conversation && conversation.role === 'project');
            const active = Boolean(supervisor && path === `/conversations/${supervisor.id}`);
            return (
              <button
                type="button"
                key={project.id}
                className="sidebar-project-row"
                data-testid={`open-project-${project.id}`}
                data-active={active ? 'true' : undefined}
                aria-current={active ? 'page' : undefined}
                aria-label={`打开 ${project.id} 的主管`}
                title={project.root}
                disabled={Boolean(openingProject)}
                onClick={() => void openProjectThread(project.id, supervisor?.id)}
              >
                <Icon name="folder" size={14} />
                <span className="sidebar-project-name">{project.id}</span>
                {openingProject === project.id && <span className="sidebar-empty">打开中…</span>}
              </button>
            );
          })}
          {archivedProjects.length > 0 && (
            <a className="sidebar-empty" href="#/settings" data-testid="archived-projects-hint">
              已归档 {archivedProjects.length} 个项目 · 在设置中恢复
            </a>
          )}
          {!projectRows.length && <div className="sidebar-empty">添加项目，让 Agent 了解你的代码。<button type="button" className="sidebar-empty-action" onClick={() => setCreateProject(true)}>添加项目<Icon name="plus" size={13} /></button></div>}
        </div>
        <div className="sidebar-label"><button type="button" className="sidebar-section-toggle" aria-expanded={sections.recent} onClick={() => setSections(value => ({ ...value, recent: !value.recent }))}><Icon name="chevron" size={12} /><span>最近</span></button>

        </div>
        <div className="sidebar-section" hidden={!sections.recent}>
          <div className="sidebar-conversations" style={{ paddingLeft: 0 }}>
            {!unbound.length && <span className="sidebar-empty">新对话会显示在这里</span>}
            {unbound.map(conversation => (
              <SidebarConversation
                key={conversation.id}
                conversation={conversation}
                active={path === `/conversations/${conversation.id}`}
                archiving={archiving === conversation.id}
                onArchive={() => void archiveConversation(conversation)}
              />
            ))}

          </div>
        </div>
      </div>
      {createProject && (
        <CreateProjectDialog
          onClose={() => setCreateProject(false)}
          onCreated={onSettingsChanged}
        />
      )}
    </>
  );
}

export function SidebarConversation({ conversation, active, archiving, onArchive, canArchive = true }: {
  conversation: ConversationSummary;
  active: boolean;
  archiving: boolean;
  onArchive: () => void;
  canArchive?: boolean;
}) {
  return (
    <div className="sidebar-conversation-row" data-active={active}>
      <a className="sidebar-conversation" href={`#/conversations/${conversation.id}`} data-active={active} title={conversation.title}>
        <Icon name="message" size={14} />
        <span className="sidebar-conversation-title">{conversation.title}</span>
        {conversation.openQuestions > 0 && <span className="sidebar-conversation-badge">{conversation.openQuestions}</span>}
      </a>
      {canArchive && <button
        type="button"
        className="sidebar-conversation-archive"
        data-testid={`archive-conversation-${conversation.id}`}
        disabled={archiving}
        onClick={onArchive}
        title="归档对话"
        aria-label={`归档对话 ${conversation.title}`}
      >
        <Icon name="archive" size={14} />
      </button>}
    </div>
  );
}
