import { MODEL_TIERS } from '../catalog/models.ts';

/** One shared selector: current tiers and explicit historical choices. */
export function ModelGradeOptions() {
  return <>
    <optgroup label="模型分层">{MODEL_TIERS.map(tier => <option key={tier} value={tier}>{tier}</option>)}</optgroup>
    <optgroup label="历史等级">{['low', 'high', 'highest'].map(grade => <option key={grade} value={grade}>{grade}</option>)}</optgroup>
  </>;
}
