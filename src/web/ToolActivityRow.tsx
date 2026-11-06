import { Icon } from './ui.tsx';
import { toolActivity } from './tool-activity.ts';
import type { TranscriptTool } from './transcript-model.ts';

// One tool call inside a group: icon, name, what it did, and how it ended.
//
// It lives beside the transcript rather than inside it because the row grew a
// state machine of its own - a background call keeps "进行中（后台）" across the
// turn that dispatched it, and a stopped call says which kind of stop it was
// (已取消 / 已超时 / 已中断) instead of a flat "失败".

function toolIcon(name: string): 'file' | 'folder' | 'search' | 'bolt' | 'refresh' {
  if (name === 'list_dir') return 'folder';
  if (name === 'search' || name === 'glob' || name === 'web_search') return 'search';
  if (name === 'run_command' || name === 'codemode') return 'bolt';
  if (['write_file', 'apply_patch', 'edit'].includes(name)) return 'file';
  if (name === 'fetch') return 'refresh';
  return 'file';
}

const STOPPED_TOOL_LABELS: Record<string, string> = { cancelled: '已取消', timed_out: '已超时', interrupted: '已中断' };

function toolStateLabel(tool: TranscriptTool) {
  if (!tool.done) return tool.background ? '进行中（后台）' : '进行中';
  // 已取消/已超时/已中断 优先于「失败」：它们也是 error 行，但读者要知道是哪一种结束。
  return STOPPED_TOOL_LABELS[tool.state ?? ''] ?? (tool.error ? '失败' : '完成');
}

export function ToolActivityRow({ tool }: { tool: TranscriptTool }) {
  return <li
    data-testid="tool-activity-row"
    data-tool-call={tool.id}
    data-error={tool.error}
    data-done={tool.done}
    data-background={tool.background === true}
    data-state={tool.state}
  >
    <span className="tool-activity-icon"><Icon name={toolIcon(tool.name)} size={14} /></span>
    <span className="tool-activity-label">{toolActivity(tool.name, tool.summary).label} <span className="tool-name">{toolActivity(tool.name, tool.summary).name}</span></span>
    <span className="tool-activity-summary" title={tool.summary}>{tool.summary}</span>
    <span className="tool-activity-state" data-testid="tool-state">{toolStateLabel(tool)}</span>
  </li>;
}
