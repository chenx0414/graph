







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
  const [projectOpen, setProjectOpen] = useState<Record<string, boolean>>({});
  const [createProject, setCreateProject] = useState(false);
  const [archiving, setArchiving] = useState('');
  const [openingProject, setOpeningProject] = useState('');
  const ordered = [...conversations].sort((left, right) => (right.updatedAt ?? right.createdAt) - (left.updatedAt ?? left.createdAt));
  const global = ordered.find(conversation => 'role' in conversation && conversation.role === 'global');
  const unbound = ordered.filter(conversation => !conversation.projectId && !('role' in conversation && conversation.role === 'global'));
  function isSupervisor(conversation: ConversationSummary) {
    return 'role' in conversation && (conversation.role === 'global' || conversation.role === 'project');
  }
  async function openProjectThread(projectId: string) {
    if (openingProject) return;
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
          {(settings?.projects ?? []).map(project => {
            const items = ordered.filter(conversation => conversation.projectId === project.id);
            return (
              <details
                className="sidebar-project"
                open={projectOpen[project.id] ?? true}
                key={project.id}
                onToggle={event => {
                  const open = event.currentTarget.open;
                  setProjectOpen(current => current[project.id] === open ? current : { ...current, [project.id]: open });
                }}
              >
                <summary>
                  <Icon name="chevron" size={13} className="sidebar-chevron" />
                  <span className="sidebar-project-name" title={project.root}>{project.id}</span>
                  <button
                    type="button"
                    className="sidebar-new-chat"
                    data-testid={`new-conversation-project-${project.id}`}
                    title={`打开 ${project.id} 的主管`}
                    aria-label={`打开 ${project.id} 的主管`}
                    disabled={Boolean(openingProject)}
                    onClick={event => { event.preventDefault(); event.stopPropagation(); void openProjectThread(project.id); }}
                  >
                    <Icon name="message" size={15} />
                  </button>
                </summary>
                <div className="sidebar-conversations">
                  {items.map(conversation => (
                    <SidebarConversation
                      key={conversation.id}
                      conversation={conversation}
                      active={path === `/conversations/${conversation.id}`}
                      archiving={archiving === conversation.id}
                      onArchive={() => void archiveConversation(conversation)}
                      canArchive={!isSupervisor(conversation)}
                    />
                  ))}
                  {!items.length && <span className="sidebar-empty">暂无对话</span>}
                </div>
              </details>
            );
          })}
          {!settings?.projects.length && <div className="sidebar-empty">添加项目，让 Agent 了解你的代码。<button type="button" className="sidebar-empty-action" onClick={() => setCreateProject(true)}>添加项目<Icon name="plus" size={13} /></button></div>}
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
