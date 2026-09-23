/**
 * What the console shows for a model's thinking strength.
 *
 * The server sends the strengths each configured model accepts (computed with
 * the SDK's own rule, and named the way that model names them), so this module
 * only decides how they are labelled and which one is selected: no component
 * keeps a level list of its own.
 */
export interface ThinkingOptionView {
  level: string;
  label: string;
}

export interface ThinkingModelView {
  id: string;
  reasoning?: boolean;
  thinkingOptions?: ThinkingOptionView[];
}

const CANONICAL_LABELS: Record<string, string> = {
  off: '关闭', minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大',
};

/** Pi's level order, used only to fall back the way the SDK does. */
const CANONICAL_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Levels a reasoning model is assumed to accept when the payload carries no
 * list at all (an older server): the previous console behaviour, never worse. */
const FALLBACK_OPTIONS: ThinkingOptionView[] = ['off', 'minimal', 'low', 'medium', 'high']
  .map(level => ({ level, label: CANONICAL_LABELS[level]! }));

export function thinkingLabel(level: string | undefined): string {
  return CANONICAL_LABELS[level ?? ''] ?? level ?? '—';
}

/** The model's own name for a level is shown whenever it differs from Pi's
 * vocabulary, so a provider-specific spelling is never hidden. A label that is
 * already the console's own wording adds nothing and is not repeated. */
export function thinkingOptionLabel(option: ThinkingOptionView): string {
  const canonical = thinkingLabel(option.level);
  return option.label && option.label !== option.level && option.label !== canonical
    ? `${canonical}（${option.label}）`
    : canonical;
}

export interface ThinkingView {
  options: ThinkingOptionView[];
  level: string;
  disabled: boolean;
  reason: string;
}

export function thinkingView(model: ThinkingModelView | undefined, requested: string | undefined): ThinkingView {
  if (!model) return { options: [], level: 'off', disabled: true, reason: '未选择模型' };
  if (model.reasoning === false) return { options: [], level: 'off', disabled: true, reason: '该模型不支持思考强度' };
  const options = model.thinkingOptions ?? FALLBACK_OPTIONS;
  if (!options.length) return { options: [], level: 'off', disabled: true, reason: '该模型没有可选的思考强度档位' };
  return { options, level: nearestLevel(options, requested), disabled: false, reason: '' };
}

/** Same fallback as the SDK: nearest stronger level, then nearest weaker. */
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
