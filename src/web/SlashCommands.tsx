import type { AgentCapabilityView, AgentToolView } from './AgentContext.tsx';
import { THINKING_LEVELS, thinkingLabel, type ComposerModel, type ComposerTelemetryView, type ThinkingLevel } from './ComposerTelemetry.tsx';
import { Icon, type IconName } from './ui.tsx';

export type SlashTarget = {
  id: string;
  kind: 'tool' | 'capability';
  label: string;
  description: string;
  source?: string;
  version?: string;
};

export type SlashScope = 'root' | 'model' | 'thinking';

export type SlashAction =
  | { type: 'open-model' }
  | { type: 'open-thinking' }
  | { type: 'compact' }
  | { type: 'tool'; target: SlashTarget }
  | { type: 'capability'; target: SlashTarget }
  | { type: 'model'; model: ComposerModel }
  | { type: 'thinking'; level: ThinkingLevel };

export type SlashEntry = {
  id: string;
  label: string;
  description: string;
  group: string;
  icon: IconName;
  action: SlashAction;
  disabled?: boolean;
};

function truncate(value: string, length = 120) {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length - 3)}...` : text;
}

function toolEntry(tool: AgentToolView): SlashEntry {
  const target: SlashTarget = {
    id: tool.name,
    kind: 'tool',
    label: tool.name,
    description: tool.description,
    source: tool.source,
    ...(tool.version ? { version: tool.version } : {}),
  };
  return {
    id: `tool:${tool.name}`,
    label: tool.name,
    description: truncate(tool.description),
    group: '工具',
    icon: 'bolt',
    action: { type: 'tool', target },
  };
}

function capabilityEntry(capability: AgentCapabilityView): SlashEntry {
  const version = capability.version;
  const label = `${capability.name || capability.id}@${version}`;
  const target: SlashTarget = {
    id: `${capability.id}@${version}`,
    kind: 'capability',
    label,
    description: capability.description ?? `${capability.kind} capability`,
    source: capability.kind,
    version,
  };
  return {
    id: `capability:${capability.id}@${version}`,
    label,
    description: truncate(capability.description ?? `${capability.kind} capability`),
    group: '能力',
    icon: 'spark',
    action: { type: 'capability', target },
  };
}

export function slashEntries(input: {
  scope: SlashScope;
  tools: readonly AgentToolView[];
  capabilities: readonly AgentCapabilityView[];
  models: readonly ComposerModel[];
  telemetry?: ComposerTelemetryView | undefined;
  canCompact: boolean;
  compactDisabled?: boolean;
}): SlashEntry[] {
  if (input.scope === 'model') {
    return input.models.map(model => ({
      id: `model:${model.id}`,
      label: model.id,
      description: `${model.grade}${model.reasoning === false ? ' · 不支持思考强度' : ''}`,
      group: '模型',
      icon: 'bolt',
      action: { type: 'model' as const, model },
      ...(model.id === input.telemetry?.model ? { description: `${model.grade} · 当前模型` } : {}),
    }));
  }
  if (input.scope === 'thinking') {
    const currentModel = input.models.find(model => model.id === input.telemetry?.model);
    const reasoning = Boolean(currentModel && currentModel.reasoning !== false);
    return THINKING_LEVELS.map(level => ({
      id: `thinking:${level}`,
      label: thinkingLabel(level),
      description: level === input.telemetry?.thinkingLevel ? '当前思考强度' : '用于下一轮模型请求',
      group: '思考强度',
      icon: 'clock',
      action: { type: 'thinking' as const, level },
      disabled: !reasoning,
    }));
  }
  const system: SlashEntry[] = [];
  if (input.models.length) {
    const currentModel = input.models.find(model => model.id === input.telemetry?.model);
    system.push({
      id: 'system:model',
      label: '选择模型',
      description: input.telemetry?.model ? `当前 ${input.telemetry.model}` : '选择一个已配置模型',
      group: '系统',
      icon: 'bolt',
      action: { type: 'open-model' },
    });
    system.push({
      id: 'system:thinking',
      label: '思考强度',
      description: `当前 ${thinkingLabel(input.telemetry?.thinkingLevel)}`,
      group: '系统',
      icon: 'clock',
      action: { type: 'open-thinking' },
      disabled: !currentModel || currentModel.reasoning === false,
    });
  }
  if (input.canCompact) {
    system.push({
      id: 'system:compact',
      label: '压缩上下文',
      description: input.compactDisabled ? '主 Agent 忙时会排队执行' : '主动压缩当前 Pi 会话上下文',
      group: '系统',
      icon: 'archive',
      action: { type: 'compact' },
      ...(input.compactDisabled ? { disabled: true } : {}),
    });
  }
  return [
    ...system,
    ...input.tools.filter(tool => tool.enabled && tool.available).map(toolEntry),
    ...input.capabilities.map(capabilityEntry),
  ];
}

export function filterSlashEntries(entries: readonly SlashEntry[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...entries];
  return entries.filter(entry => [
    entry.label,
    entry.description,
    entry.group,
    entry.action.type,
  ].some(value => value.toLowerCase().includes(needle)));
}

export function composeSlashDirective(text: string, targets: readonly SlashTarget[]) {
  const unique = [...new Map(targets.map(target => [target.id, target])).values()];
  if (!unique.length) return text.trim();
  const requested = unique.map(target => {
    const source = [target.source, target.version].filter(Boolean).join(' · ');
    return `- ${target.kind} \`${target.label}\`${source ? ` (${source})` : ''}: ${target.description}`;
  });
  return [
    text.trim(),
    [
      'The user explicitly requested the following tools and capabilities for this turn:',
      ...requested,
      'Use them where applicable. Do not claim a tool or capability was used without its tool result.',
    ].join('\n'),
  ].filter(Boolean).join('\n\n');
}

export function SlashMenu({
  scope,
  entries,
  query,
  activeIndex,
  onChoose,
  onBack,
}: {
  scope: SlashScope;
  entries: readonly SlashEntry[];
  query: string;
  activeIndex: number;
  onChoose: (entry: SlashEntry) => void;
  onBack: () => void;
}) {
  const groups = new Map<string, { entry: SlashEntry; index: number }[]>();
  entries.forEach((entry, index) => {
    const items = groups.get(entry.group) ?? [];
    items.push({ entry, index });
    groups.set(entry.group, items);
  });
  const title = scope === 'root' ? '工具、能力与系统命令' : scope === 'model' ? '选择模型' : '思考强度';
  return (
    <div className="mention-popover slash-popover" data-testid="slash-popover">
      <div className="mention-popover-head">
        <span className="slash-head-title">
          {scope !== 'root' && (
            <button type="button" className="slash-back" data-testid="slash-back" onMouseDown={event => event.preventDefault()} onClick={onBack} aria-label="返回命令列表">
              <Icon name="chevron" size={12} />
            </button>
          )}
          {title}
        </span>
        <span className="faint">/ {query || '全部'}</span>
      </div>
      {entries.length ? (
        <div className="mention-list slash-list" role="listbox">
          {[...groups.entries()].map(([group, items]) => (
            <div className="slash-group" key={group}>
              <div className="slash-group-label">{group}</div>
              {items.map(({ entry, index }) => (
                <button
                  key={entry.id}
                  type="button"
                  className="mention-item slash-item"
                  data-active={activeIndex === index}
                  data-disabled={entry.disabled ? 'true' : undefined}
                  role="option"
                  aria-selected={activeIndex === index}
                  disabled={entry.disabled}
                  data-testid={`slash-${entry.id.replace(/[^A-Za-z0-9_-]+/g, '-')}`}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => onChoose(entry)}
                >
                  <Icon name={entry.icon} size={14} />
                  <span className="slash-item-copy">
                    <strong>{entry.label}</strong>
                    <small>{entry.description}</small>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="mention-empty">没有匹配的工具、能力或系统命令</div>
      )}
    </div>
  );
}
