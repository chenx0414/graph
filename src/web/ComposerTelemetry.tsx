import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { formatTokens } from './insights.ts';
import { Icon, toast } from './ui.tsx';
import { thinkingLabel, thinkingOptionLabel, thinkingView } from './thinking-levels.ts';

export { thinkingLabel };

/** Pi's own thinking vocabulary: the only value Graph stores or sends. Which of
 * these a given model accepts is decided per model (see thinking-levels.ts). */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ComposerModel = {
  id: string;
  grade: string;
  credentialId?: string;
  contextWindow?: number;
  reasoning?: boolean;
  defaultThinkingLevel?: string;
  thinkingOptions?: { level: string; label: string }[];
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
  const [draftLevel, setDraftLevel] = useState('off');
  const rootRef = useRef<HTMLDivElement>(null);
  const model = models.find(item => item.id === telemetry?.model);
  const view = thinkingView(model, telemetry?.thinkingLevel);
  useEffect(() => setDraftLevel(view.level), [view.level]);
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
  async function applySelection(nextModel: ComposerModel | undefined, nextLevel: string) {
    if (!nextModel || saving || disabled) return false;
    // The level is re-resolved against the model being switched to: a model with
    // fewer strengths must never be handed one it does not accept.
    const level = thinkingView(nextModel, nextLevel).level;
    setSaving(true);
    try {
      await onSelect(nextModel, level as ThinkingLevel);
      return true;
    } catch (reason) {
      toast(`切换失败：${reason instanceof Error ? reason.message : String(reason)}`, 'danger');
      return false;
    } finally {
      setSaving(false);
    }
  }
  async function commitThinking(value: string) {
    const level = view.options[Number(value)]?.level ?? view.level;
    setDraftLevel(level);
    if (view.disabled || saving || disabled || level === view.level) return;
    if (!await applySelection(model, level)) setDraftLevel(view.level);
  }
  const draftIndex = Math.max(0, view.options.findIndex(option => option.level === draftLevel));
  const sliderMax = Math.max(0, view.options.length - 1);
  const sliderStyle = {
    '--thinking-progress': `${sliderMax ? (draftIndex / sliderMax) * 100 : 0}%`,
  } as CSSProperties;
  const current = view.options.find(option => option.level === view.level);
  const draft = view.options.find(option => option.level === draftLevel);
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
          <span
            title={view.fallbackFrom
              ? `当前 Agent 内核的思考强度：已保存的 ${view.fallbackFrom} 不在该模型档位内，按 ${view.level} 执行`
              : '当前 Agent 内核的思考强度'}
            data-testid="telemetry-thinking"
            data-level={view.level}
            data-saved-level={view.fallbackFrom ?? undefined}
          >
            <Icon name="clock" size={13} />思考 {current ? thinkingOptionLabel(current) : thinkingLabel(telemetry?.thinkingLevel)}
          </span>
          <Icon name="chevron" size={12} className="composer-model-chevron" />
        </button>
        {open && (
          <div className="model-control-popover" data-testid="model-menu" role="dialog" aria-label="模型与思考强度">
            <div className="model-control-head">
              <span>思考强度</span>
              <span data-testid="thinking-current">{draft ? thinkingOptionLabel(draft) : thinkingLabel(draftLevel)}</span>
            </div>
            <div className="model-control-selected" title="切换后沿用当前上下文，从下一次调用生效">{telemetry?.model ?? '未选择模型'}</div>
            <input
              className="thinking-slider"
              data-testid="thinking-slider"
              data-levels={view.options.map(option => option.level).join(',')}
              type="range"
              min="0"
              max={sliderMax}
              step="1"
              value={draftIndex}
              style={sliderStyle}
              disabled={view.disabled || saving || disabled}
              aria-label="思考强度"
              aria-valuetext={draft ? thinkingOptionLabel(draft) : thinkingLabel(draftLevel)}
              onChange={event => setDraftLevel(view.options[Number(event.currentTarget.value)]?.level ?? view.level)}
              onPointerUp={event => void commitThinking(event.currentTarget.value)}
              onKeyUp={event => void commitThinking(event.currentTarget.value)}
            />
            <div className="thinking-labels" data-testid="thinking-labels">
              {view.options.map(option => <span key={option.level} data-level={option.level}>{thinkingOptionLabel(option)}</span>)}
            </div>
            {view.disabled && <p className="thinking-note" data-testid="thinking-disabled">{view.reason}</p>}
            {view.fallbackFrom && (
              <p className="thinking-note" data-testid="thinking-fallback">
                已保存的 {view.fallbackFrom} 不在该模型档位内，按 {view.level} 执行
              </p>
            )}
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
                  onClick={() => void applySelection(option, view.level)}
                >
                  <span className="grow truncate">{option.id}</span>
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
