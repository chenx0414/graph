export interface ThinkingOptionView {
  level: string;
  label: string;
}

export interface ThinkingModelView {
  id: string;
  reasoning?: boolean;
  thinkingOptions?: ThinkingOptionView[];
}

const CANONICAL_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const FALLBACK_OPTIONS: ThinkingOptionView[] = ['minimal', 'low', 'medium', 'high']
  .map(level => ({ level, label: level }));

export function thinkingLabel(level: string | undefined): string {
  return level && level.trim() ? level : '—';
}

export function thinkingOptionLabel(option: ThinkingOptionView): string {
  return option.label || option.level;
}

export interface ThinkingView {
  options: ThinkingOptionView[];
  level: string;
  disabled: boolean;
  reason: string;
  fallbackFrom?: string;
}

export function thinkingView(model: ThinkingModelView | undefined, requested: string | undefined): ThinkingView {
  if (!model) return { options: [], level: 'off', disabled: true, reason: '未选择模型' };
  const options = model.thinkingOptions ?? FALLBACK_OPTIONS;
  if (!options.length) return { options: [], level: 'off', disabled: true, reason: '该模型没有可选的思考强度档位' };
  const level = nearestLevel(options, requested);
  return {
    options,
    level,
    disabled: false,
    reason: '',
    ...(requested && requested !== level ? { fallbackFrom: requested } : {}),
  };
}

export function nearestLevel(options: ThinkingOptionView[], requested: string | undefined): string {
  if (!options.length) return 'off';
  if (requested && options.some(option => option.level === requested)) return requested;
  const wanted = CANONICAL_ORDER.indexOf(requested ?? '');
  if (wanted === -1) return options[0]!.level;
  let weaker: string | undefined;
  for (const option of options) {
    if (CANONICAL_ORDER.indexOf(option.level) >= wanted) return option.level;
    weaker = option.level;
  }
  return weaker ?? options[0]!.level;
}
