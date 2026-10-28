import { ArtifactDetail } from './ArtifactViews.tsx';

import { ArtifactIndex } from './ArtifactIndex.tsx';

import { DraftGraphTab } from './DraftGraphTab.tsx';




import {
type WorkspaceTabKind
} from './workspace-tabs.ts';


import { Suspense } from 'react';


import { AgentContextPage } from './AgentContext.tsx';






import { GraphPanel } from './GraphPanel.tsx';

import { NodeChatTab } from './NodeDetail.tsx';

import { ConversationPanel,type ConversationSummary } from './Conversation.tsx';





import { Spinner } from './ui.tsx';



import { NewConversation } from "./app-new-conversation.tsx";
import type { Settings_,Startup,TaskSummary } from "./app-state.tsx";
import { CapabilityResourceLibrary,ModelsPage,ToolStatsPage,UsagePage } from "./app-state.tsx";

export function WorkspacePage({ path, active, settings, startup, tasks, conversations, reloadConversations, refreshTasks, detailOpen, setDetailOpen, retitleWorkspaceTab }: {
  path: string; active: boolean; settings: Settings_ | null; startup: Startup | null; tasks: TaskSummary[]; conversations: ConversationSummary[];
  refreshTasks: () => Promise<void>; reloadConversations: () => void; detailOpen: boolean; setDetailOpen: (open: boolean) => void;
  retitleWorkspaceTab: (kind: WorkspaceTabKind, key: string, title: string) => void;
}) {
  const [pathname, query = ''] = path.split('?');
  const queryParams = new URLSearchParams(query);
  const catalogMatch = /^\/catalog(?:\/([^/]+))?$/.exec(pathname ?? '/');
  const taskMatch = /^\/tasks\/([^/]+)(?:\/graph)?$/.exec(pathname ?? '/');
  const nodeMatch = /^\/tasks\/([^/]+)\/nodes\/([^/]+)$/.exec(pathname ?? '/');
  const artifactMatch = /^\/tasks\/([^/]+)\/artifacts\/([^/]+)$/.exec(pathname ?? '/');
  const draftGraphMatch = /^\/conversations\/([^/]+)\/graph$/.exec(pathname ?? '/');
  const contextMatch = /^\/conversations\/([^/]+)\/context$/.exec(pathname ?? '/');
  const conversationMatch = /^\/conversations\/([^/]+)$/.exec(pathname ?? '/');
  const conversationFirst = pathname === '/' || Boolean(conversationMatch || draftGraphMatch || nodeMatch || contextMatch);
  return <div className={`content ${conversationFirst ? 'conversation-content' : ''}`}>
    <div className={`page ${conversationFirst ? 'conversation-page-host' : ''}`}>
            {pathname === '/' && <NewConversation settings={settings} initialProjectId={queryParams.get('project') ?? ''} />}
            {contextMatch && <AgentContextPage conversationId={contextMatch[1]!} />}
            {catalogMatch && <Suspense fallback={<Spinner />}><CapabilityResourceLibrary settings={settings} section={catalogMatch[1]} /></Suspense>}
            {pathname === '/usage' && <Suspense fallback={<Spinner />}><UsagePage /></Suspense>}
            {pathname === '/tools' && <Suspense fallback={<Spinner />}><ToolStatsPage /></Suspense>}
            {pathname === '/models' && <Suspense fallback={<Spinner />}><ModelsPage /></Suspense>}
            {draftGraphMatch && (
              <DraftGraphTab
                key={draftGraphMatch[1]}
                conversationId={draftGraphMatch[1]!}
                {...(queryParams.get('v') ? { version: Number(queryParams.get('v')) } : {})}
              />
            )}
            {pathname === '/artifacts' && (
              <ArtifactIndex
                projectId={queryParams.get('project') ?? settings?.projects[0]?.id ?? ''}
                projects={settings?.projects ?? []}
                tasks={tasks}
                conversations={conversations}
              />
            )}
            {conversationMatch && (
              <ConversationPanel
                key={conversationMatch[1]}
                id={conversationMatch[1]!}
                settings={settings}
                onChanged={reloadConversations}
                drawerOpen={active && detailOpen}
                onDrawerOpenChange={setDetailOpen}
              />
            )}
            {artifactMatch && (
              <ArtifactDetail
                key={`${artifactMatch[1]}:${artifactMatch[2]}:${queryParams.get('v') ?? ''}`}
                taskId={artifactMatch[1]!}
                artifactId={artifactMatch[2]!}
                {...(queryParams.get('v') ? { version: Number(queryParams.get('v')) } : {})}
                onTitle={title => retitleWorkspaceTab('artifact', `${artifactMatch[1]}/${artifactMatch[2]}`, title)}
              />
            )}
            {nodeMatch && (
              <NodeChatTab
                key={`${nodeMatch[1]}:${nodeMatch[2]}`}
                taskId={nodeMatch[1]!}
                nodeId={decodeURIComponent(nodeMatch[2]!)}
              />
            )}
            {taskMatch && <GraphPanel id={taskMatch[1]!} />}
    </div>
  </div>;
}
