import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { formatTokens } from './insights.ts';
import { Icon, toast } from './ui.tsx';

export const THINKING_LEVELS = ['off', 'low', 'medium', 'high'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type ComposerModel = {
  id: string;
  grade: string;
  credentialId?: string;
  contextWindow?: number;
  reasoning?: boolean;
  defaultThinkingLevel?: string;
};

export type ComposerTelemetryView = {
  model: string | null;
  thinkingLevel: string;
  cacheHitRate: number | null;
  cachedInput: number;
  cacheInput: number;
  contextTokens: number | null;
  contextLimit: number | null;
  contextPercent: number | null;
};

export function thinkingLabel(level: string | undefined) {
  return ({ off: '关闭', minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大' } as Record<string, string>)[level ?? ''] ?? level ?? '—';
}

function telemetryValue(value: number | null | undefined, render: (value: number) => string) {
  return value === null || value === undefined ? '—' : render(value);
}

/** Model and thinking-strength control shared by an existing conversation and
 * the pre-creation composer. The parent owns persistence/state via onSelect. */
export function ComposerTelemetry({ telemetry, models, onSelect, disabled = false }: {
  telemetry?: ComposerTelemetryView | undefined;
  models: ComposerModel[];
  onSelect: (model: ComposerModel, thinkingLevel: ThinkingLevel) => Promise<void> | void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftLevel, setDraftLevel] = useState<ThinkingLevel>('off');
  const rootRef = useRef<HTMLDivElement>(null);
  const model = models.find(item => item.id === telemetry?.model);
  const reasoning = Boolean(model && model.reasoning !== false);
  const currentLevel = (THINKING_LEVELS.includes(telemetry?.thinkingLevel as ThinkingLevel)
    ? telemetry?.thinkingLevel
    : 'off') as ThinkingLevel;
  useEffect(() => setDraftLevel(currentLevel), [currentLevel]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  async function applySelection(nextModel: ComposerModel | undefined, nextLevel: ThinkingLevel) {
    if (!nextModel || saving || disabled) return false;
    const level = nextModel.reasoning === false ? 'off' : nextLevel;
    setSaving(true);
    try {
      await onSelect(nextModel, level);
      return true;
    } catch (reason) {
      toast(`切换失败：${reason instanceof Error ? reason.message : String(reason)}`, 'danger');
      return false;
    } finally {
      setSaving(false);
    }
  }
  async function commitThinking(value: string) {
    const level = THINKING_LEVELS[Number(value)] ?? 'off';
    setDraftLevel(level);
    if (!reasoning || saving || disabled || level === currentLevel) return;
    if (!await applySelection(model, level)) setDraftLevel(currentLevel);
  }
  const draftIndex = THINKING_LEVELS.indexOf(draftLevel);
  const sliderStyle = {
    '--thinking-progress': `${(draftIndex / (THINKING_LEVELS.length - 1)) * 100}%`,
  } as CSSProperties;
  return (
    <div className="composer-telemetry" data-testid="composer-telemetry" aria-label="当前模型运行指标">
      <span title="缓存输入占全部输入 token 的比例" data-testid="telemetry-cache">
        <Icon name="spark" size={13} />
        缓存 {telemetryValue(telemetry?.cacheHitRate, value => `${(value * 100).toFixed(value >= 0.1 ? 0 : 1)}%`)}
      </span>
      <span title="最近一次完成请求使用的输入 token 与模型上下文窗口" data-testid="telemetry-context">
        <Icon name="graph" size={13} />
        上下文 {telemetryValue(telemetry?.contextTokens, formatTokens)}
        {telemetry?.contextLimit ? ` / ${formatTokens(telemetry.contextLimit)}` : ''}
        {telemetry?.contextPercent !== null && telemetry?.contextPercent !== undefined ? ` · ${telemetry.contextPercent.toFixed(telemetry.contextPercent >= 10 ? 0 : 1)}%` : ''}
      </span>
      <div className="composer-model-control" ref={rootRef}>
        <button
          type="button"
          className="composer-model-trigger"
          data-testid="model-control"
          data-open={open}
          disabled={saving || disabled}
          onClick={() => setOpen(value => !value)}
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          <span title="当前主管使用的模型" data-testid="telemetry-model"><Icon name="bolt" size={13} />{telemetry?.model ?? '未选择模型'}</span>
          <span title="当前 Agent 内核的思考强度" data-testid="telemetry-thinking"><Icon name="clock" size={13} />思考 {thinkingLabel(telemetry?.thinkingLevel)}</span>
          <Icon name="chevron" size={12} className="composer-model-chevron" />
        </button>
        {open && (
          <div className="model-control-popover" data-testid="model-menu" role="dialog" aria-label="模型与思考强度">
            <div className="model-control-head">
              <span>思考强度</span>
              <span data-testid="thinking-current">{thinkingLabel(draftLevel)}</span>
            </div>
            <div className="model-control-selected">{telemetry?.model ?? '未选择模型'}</div>
            <input
              className="thinking-slider"
              data-testid="thinking-slider"
              type="range"
              min="0"
              max={THINKING_LEVELS.length - 1}
              step="1"
              value={draftIndex}
              style={sliderStyle}
              disabled={!reasoning || saving || disabled}
              aria-label="思考强度"
              aria-valuetext={thinkingLabel(draftLevel)}
              onChange={event => setDraftLevel(THINKING_LEVELS[Number(event.currentTarget.value)] ?? 'off')}
              onPointerUp={event => void commitThinking(event.currentTarget.value)}
              onKeyUp={event => void commitThinking(event.currentTarget.value)}
            />
            <div className="thinking-labels">
              {THINKING_LEVELS.map(level => <span key={level}>{thinkingLabel(level)}</span>)}
            </div>
            <div className="model-options" role="listbox" aria-label="选择模型">
              {models.length === 0 && <span className="model-option-empty">没有可用模型</span>}
              {models.map(option => (
                <button
                  key={option.id}
                  type="button"
                  role="option"
                  aria-selected={option.id === telemetry?.model}
                  data-active={option.id === telemetry?.model}
                  data-testid={`model-option-${option.id}`}
                  disabled={saving || disabled}
                  onClick={() => void applySelection(option, currentLevel)}
                >
                  <span className="grow truncate">{option.id}</span>
                  <span className="faint">{option.reasoning === false ? '标准' : '可思考'}</span>
                  {option.id === telemetry?.model && <Icon name="check" size={13} />}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
