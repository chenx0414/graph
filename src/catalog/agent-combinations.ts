import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RuntimeError, type Json } from '../core/types.ts';
import type { ModelGrade } from './models.ts';
import type { RecommendedResource } from './resource-catalog.ts';

export type AgentCombinationResourceRole = 'identity' | 'skill' | 'mcp' | 'pi-extension';

export interface AgentCombinationResource {
  resourceId: string;
  role: AgentCombinationResourceRole;
  required: boolean;
}

export interface AgentCombination {
  id: string;
  name: string;
  description: string;
  recommendedGrade: ModelGrade;
  review: boolean;
  tags: string[];
  resources: AgentCombinationResource[];
}

interface AgentCombinationDocument {
  version: number;
  combinations: AgentCombination[];
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const GRADES = new Set<ModelGrade>(['low', 'medium', 'high', 'highest']);
const ROLES = new Set<AgentCombinationResourceRole>(['identity', 'skill', 'mcp', 'pi-extension']);

function text(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new RuntimeError('invalid_agent_combination', `${label} must be a nonempty string`);
  return value.trim();
}

function textList(value: unknown, label: string) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new RuntimeError('invalid_agent_combination', `${label} must be an array of nonempty strings`);
  }
  return [...new Set(value.map(item => item.trim()))];
}

export function parseAgentCombinations(value: unknown): AgentCombinationDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeError('invalid_agent_combination', 'Agent combinations must be an object');
  }
  const document = value as { version?: unknown; combinations?: unknown };
  if (!Number.isInteger(document.version) || Number(document.version) < 1) {
    throw new RuntimeError('invalid_agent_combination', 'Agent combinations version must be a positive integer');
  }
  if (!Array.isArray(document.combinations)) throw new RuntimeError('invalid_agent_combination', 'combinations must be an array');
  const ids = new Set<string>();
  const combinations = document.combinations.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new RuntimeError('invalid_agent_combination', `combinations[${index}] must be an object`);
    }
    const entry = raw as Record<string, unknown>;
    const id = text(entry.id, `combinations[${index}].id`);
    if (!ID_PATTERN.test(id)) throw new RuntimeError('invalid_agent_combination', `Agent combination id ${id} is invalid`);
    if (ids.has(id)) throw new RuntimeError('invalid_agent_combination', `Duplicate Agent combination id ${id}`);
    ids.add(id);
    const recommendedGrade = text(entry.recommendedGrade, `combinations[${index}].recommendedGrade`) as ModelGrade;
    if (!GRADES.has(recommendedGrade)) throw new RuntimeError('invalid_agent_combination', `Agent combination ${id} has unsupported grade ${recommendedGrade}`);
    if (entry.review !== undefined && typeof entry.review !== 'boolean') throw new RuntimeError('invalid_agent_combination', `combinations[${index}].review must be a boolean`);
    if (!Array.isArray(entry.resources) || !entry.resources.length) {
      throw new RuntimeError('invalid_agent_combination', `Agent combination ${id} must reference at least one resource`);
    }
    const seen = new Set<string>();
    const resources = entry.resources.map((rawResource, resourceIndex) => {
      if (!rawResource || typeof rawResource !== 'object' || Array.isArray(rawResource)) {
        throw new RuntimeError('invalid_agent_combination', `combinations[${index}].resources[${resourceIndex}] must be an object`);
      }
      const resource = rawResource as Record<string, unknown>;
      const resourceId = text(resource.resourceId, `combinations[${index}].resources[${resourceIndex}].resourceId`);
      const role = text(resource.role, `combinations[${index}].resources[${resourceIndex}].role`) as AgentCombinationResourceRole;
      if (!ROLES.has(role)) throw new RuntimeError('invalid_agent_combination', `Agent combination ${id} has unsupported resource role ${role}`);
      if (resource.required !== undefined && typeof resource.required !== 'boolean') {
        throw new RuntimeError('invalid_agent_combination', `combinations[${index}].resources[${resourceIndex}].required must be a boolean`);
      }
      const seenKey = `${role}:${resourceId}`;
      if (seen.has(seenKey)) throw new RuntimeError('invalid_agent_combination', `Agent combination ${id} repeats ${resourceId} in role ${role}`);
      seen.add(seenKey);
      return { resourceId, role, required: resource.required !== false };
    });
    return {
      id,
      name: text(entry.name, `combinations[${index}].name`),
      description: text(entry.description, `combinations[${index}].description`),
      recommendedGrade,
      review: entry.review === true,
      tags: textList(entry.tags, `combinations[${index}].tags`),
      resources,
    };
  });
  return { version: Number(document.version), combinations };
}

export async function loadAgentCombinations(root: string, resources: RecommendedResource[]) {
  const document = JSON.parse(await readFile(join(root, 'agent-combinations.json'), 'utf8')) as Json;
  const parsed = parseAgentCombinations(document);
  const available = new Map(resources.map(resource => [resource.id, resource]));
  for (const combination of parsed.combinations) {
    for (const member of combination.resources) {
      const resource = available.get(member.resourceId);
      if (!resource) throw new RuntimeError('invalid_agent_combination', `Agent combination ${combination.id} references unknown resource ${member.resourceId}`);
      const expected = member.role === 'identity' ? 'agent-md' : member.role;
      if (resource.kind !== expected) {
        throw new RuntimeError('invalid_agent_combination', `Agent combination ${combination.id} expects ${member.resourceId} to be ${expected}, found ${resource.kind}`);
      }
    }
  }
  return parsed;
}

export function resolveAgentCombination(
  combination: AgentCombination,
  resources: RecommendedResource[],
) {
  const available = new Map(resources.map(resource => [resource.id, resource]));
  return {
    ...combination,
    resources: combination.resources.map(member => ({
      ...member,
      resource: available.get(member.resourceId)!,
    })),
  };
}
