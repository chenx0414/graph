import { Icon } from './ui.tsx';
import { toolActivity } from './tool-activity.ts';
import type { TranscriptTool } from './transcript-model.ts';


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
  if (!tool.done) return '进行中';
  return STOPPED_TOOL_LABELS[tool.state ?? ''] ?? (tool.error ? '失败' : '完成');
}

export function ToolActivityRow({ tool }: { tool: TranscriptTool }) {
  return <li
    data-testid="tool-activity-row"
    data-tool-call={tool.id}
    data-error={tool.error}
    data-done={tool.done}
    data-state={tool.state}
  >
    <span className="tool-activity-icon"><Icon name={toolIcon(tool.name)} size={14} /></span>
    <span className="tool-activity-label">{toolActivity(tool.name, tool.summary).label} <span className="tool-name">{toolActivity(tool.name, tool.summary).name}</span></span>
    <span className="tool-activity-summary" title={tool.summary}>{tool.summary}</span>
    <span className="tool-activity-state" data-testid="tool-state">{toolStateLabel(tool)}</span>
  </li>;
}
