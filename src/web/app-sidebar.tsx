







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
  const [sections, setSections] = useState({ projects: true });
  const [createProject, setCreateProject] = useState(false);
  const [openingProject, setOpeningProject] = useState('');
  const [openingGlobal, setOpeningGlobal] = useState(false);
  const ordered = [...conversations].sort((left, right) => (right.updatedAt ?? right.createdAt) - (left.updatedAt ?? left.createdAt));
  const global = ordered.find(conversation => 'role' in conversation && conversation.role === 'global');
  const projectRows = settings?.projects ?? [];
  const listedProjects = projectRows.filter(project => !project.ownCheckout);
  const activeProjects = listedProjects.filter(project => project.archivedAt == null);
  async function openGlobalThread() {
    if (openingGlobal) return;
    if (global) {
      location.hash = `#/conversations/${global.id}`;
      return;
    }
    setOpeningGlobal(true);
    try {
      const thread = await api<{ conversationId: string }>('/api/orchestration/global', {
        method: 'POST', body: JSON.stringify({ requestId: `open-global-${crypto.randomUUID()}` }),
      });
      window.dispatchEvent(new Event('graph:conversations-changed'));
      location.hash = `#/conversations/${thread.conversationId}`;
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : String(reason), 'danger');
    } finally {
      setOpeningGlobal(false);
    }
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
  return (
    <>
      <div className="sidebar-scroll" data-testid="conversation-list">
        <div className="sidebar-section">
          {/* One main Agent, one conversation: the entry is the row itself, with no
              heading above it and no second row to pick from. */}
          <button
            type="button"
            className="sidebar-project-row"
            data-testid="open-global-agent"
            data-active={global && path === `/conversations/${global.id}` ? 'true' : undefined}
            aria-current={global && path === `/conversations/${global.id}` ? 'page' : undefined}
            aria-label="打开主 Agent 的对话"
            title={global?.title ?? '主 Agent'}
            disabled={Boolean(openingGlobal)}
            onClick={() => void openGlobalThread()}
          >
            <Icon name="message" size={14} />
            <span className="sidebar-project-name">主 Agent</span>
            {Boolean(global?.openQuestions) && <span className="sidebar-conversation-badge">{global?.openQuestions}</span>}
            {openingGlobal && <span className="sidebar-empty">打开中…</span>}
          </button>
        </div>
        <div className="sidebar-label">
          <button type="button" className="sidebar-section-toggle" aria-expanded={sections.projects} onClick={() => setSections(value => ({ ...value, projects: !value.projects }))}><Icon name="chevron" size={12} /><span>项目</span></button>
          <button type="button" className="sidebar-add" data-testid="project-create-open" onClick={() => setCreateProject(true)} aria-label="新建项目" title="新建项目">
            <Icon name="plus" size={15} />
          </button>
        </div>
        <div className="sidebar-section" hidden={!sections.projects}>
          {activeProjects.map(project => {
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
                onClick={() => void openProjectThread(project.id)}
              >
                <Icon name="folder" size={14} />
                <span className="sidebar-project-name">{project.id}</span>
                {openingProject === project.id && <span className="sidebar-empty">打开中…</span>}
              </button>
            );
          })}
          {!projectRows.length && <div className="sidebar-empty">添加项目，让 Agent 了解你的代码。<button type="button" className="sidebar-empty-action" onClick={() => setCreateProject(true)}>添加项目<Icon name="plus" size={13} /></button></div>}
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
