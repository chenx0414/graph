
export type ConversationDrawerPage = 'graph' | 'artifacts' | 'task';

export type ConversationDrawerSection = 'draft' | 'task';

export interface DrawerSectionInput {
  current: ConversationDrawerSection;
  selectedTaskId: string | null;
  taskIds: readonly string[];
}

export interface DrawerSectionResolution {
  section: ConversationDrawerSection;
  taskId: string | null;
}

export function resolveDrawerSection(input: DrawerSectionInput): DrawerSectionResolution {
  const { current, selectedTaskId, taskIds } = input;
  if (current === 'draft') return { section: 'draft', taskId: selectedTaskId };
  const stillThere = selectedTaskId !== null && taskIds.includes(selectedTaskId);
  return { section: 'task', taskId: stillThere ? selectedTaskId : (taskIds[0] ?? null) };
}

export interface DrawerEntryLink {
  id: 'graph' | 'artifacts';
  label: string;
  target: 'draft-graph' | 'task-graph' | 'artifact-index';
}

export const DRAWER_ENTRY_LINKS: readonly DrawerEntryLink[] = [
  { id: 'graph', label: '任务图', target: 'task-graph' },
  { id: 'artifacts', label: '共享产物', target: 'artifact-index' },
];

export interface ArtifactGraphGroup<T> {
  taskId: string;
  request: string;
  records: T[];
}

export function groupArtifactsByTask<T extends { scope: string; taskId: string }>(
  records: readonly T[],
  tasks: readonly { id: string; request: string }[],
): { graphs: ArtifactGraphGroup<T>[]; project: T[] } {
  const taskRequests = new Map(tasks.map(task => [task.id, task.request]));
  const byTask = new Map<string, T[]>();
  for (const record of records) {
    if (record.scope === 'project') continue;
    const group = byTask.get(record.taskId) ?? [];
    group.push(record);
    byTask.set(record.taskId, group);
  }
  const orderedIds = [
    ...tasks.map(task => task.id).filter(id => byTask.has(id)),
    ...[...byTask.keys()].filter(id => !taskRequests.has(id)),
  ];
  return {
    graphs: orderedIds.map(taskId => ({
      taskId,
      request: taskRequests.get(taskId) ?? taskId,
      records: byTask.get(taskId)!,
    })),
    project: records.filter(record => record.scope === 'project'),
  };
}

const DRAWER_PANEL_IDS = [
  'draft-versions',
  'graph',
  'artifacts',
  'task-nav',
  'task',
  'task-empty',
  'bind-project',
] as const;

const DRAWER_INIT_PANEL_IDS = [
  'task-empty',
  'bind-project',
] as const;

const CHAT_RESIDENT_PANEL_IDS = [
  'conversation-messages',
  'conversation-questions',
  'conversation-composer',
] as const;

export type DraftStatus = 'none' | 'pending' | 'accepted' | 'stale';

export function defaultDrawerOpen(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement.dataset.window === 'drawer';
}

export function drawerPanelIds(): readonly string[] {
  return DRAWER_PANEL_IDS;
}

export function drawerInitPanelIds(): readonly string[] {
  return DRAWER_INIT_PANEL_IDS;
}

export function residentPanelIds(): readonly string[] {
  return CHAT_RESIDENT_PANEL_IDS;
}

export function isResidentPanel(id: string): boolean {
  return (CHAT_RESIDENT_PANEL_IDS as readonly string[]).includes(id);
}

export function draftStatusLabel(status: DraftStatus): string {
  switch (status) {
    case 'pending': return '待确认';
    case 'accepted': return '已确认';
    case 'stale': return '已过期';
    default: return '暂无草稿';
  }
}

export interface DrawerEntryState {
  proposalVersion: number | null;
  draftStatus: DraftStatus;
  taskCount: number;
  projectBound: boolean;
}

function drawerEntryLabel(state: DrawerEntryState): string {
  const draft = state.proposalVersion === null || state.draftStatus === 'none'
    ? '暂无草稿'
    : `草稿 v${state.proposalVersion} · ${draftStatusLabel(state.draftStatus)}`;
  const parts = [draft];
  if (!state.projectBound) parts.push('未绑定项目');
  parts.push(`任务 ${state.taskCount}`);
  return parts.join(' · ');
}

export function drawerEntryAriaLabel(state: DrawerEntryState): string {
  return `${drawerEntryLabel(state)}，打开草稿与任务抽屉`;
}
