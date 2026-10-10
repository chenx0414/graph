import type { Catalog } from '../catalog/catalog.ts';
import { selectModel, type ModelEntry } from '../catalog/models.ts';
import type { NodeSpec } from './types.ts';

export function pickModel(input: {
  spec: NodeSpec;
  models: () => ModelEntry[];
  catalog?: Catalog;
  preferences?: Partial<Record<ModelEntry['grade'], string[]>>;
}) {
  const directory = input.models();
  let definition: { recommendedGrade: ModelEntry['grade']; review?: boolean } = { recommendedGrade: 'medium' };
  if (input.spec.definitionVersion && input.catalog) {
    try { definition = input.catalog.definition(input.spec.definitionVersion); }
    catch { /* Unpublished keys still select by their requested model. */ }
  }
  return selectModel({
    ...(input.spec.model ? { requested: input.spec.model } : {}),
    grade: definition.recommendedGrade,
    directory,
    ...(input.preferences ? { preferences: input.preferences } : {}),
  });
}
