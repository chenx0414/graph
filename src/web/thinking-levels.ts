/**
 * What the console shows for a model's thinking strength.
 *
 * The server sends the strengths each configured model accepts (computed with
 * the SDK's own rule, and named the way that model names them), so this module
 * only decides which one is selected and how it is written: no component keeps
 * a level list of its own.
 *
 * Levels are never translated. A strength is a provider vocabulary term
 * (off, low, high, xhigh, max, or a provider's own spelling such as none), and
 * a translated word would stop matching what the provider, the config file and
 * the API calls actually say.
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

/** Pi's level order, used only to fall back the way the SDK does. */
const CANONICAL_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Levels assumed when the payload carries no list at all (an older server).
 * `off` is never among them: a strength is always chosen. */
const FALLBACK_OPTIONS: ThinkingOptionView[] = ['minimal', 'low', 'medium', 'high']
  .map(level => ({ level, label: level }));

/** A level is written exactly as the model vocabulary writes it. */
export function thinkingLabel(level: string | undefined): string {
  return level && level.trim() ? level : '—';
}

/** The provider's own spelling when the catalog names one (deepseek calls its
 * top level max, ChatGPT calls the off level none), otherwise the level itself. */
export function thinkingOptionLabel(option: ThinkingOptionView): string {
  return option.label || option.level;
}

export interface ThinkingView {
  options: ThinkingOptionView[];
  level: string;
  disabled: boolean;
  reason: string;
  /** The saved level this model does not accept, when it had to be replaced. */
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
