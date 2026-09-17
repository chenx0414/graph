import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RuntimeError, type Json } from '../core/types.ts';
import type { CapabilityRecord, DefinitionSpec } from './catalog.ts';
import type { ModelGrade } from './models.ts';

export type AgentCombinationResourceRole = 'identity' | 'tool' | 'skill' | 'mcp' | 'pi-extension' | 'extension';

export interface AgentCombinationResource {
  resourceId: string;
  version?: string;
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

export interface AgentCombinationView extends AgentCombination {
  status: 'valid' | 'invalid';
  issues: string[];
  resolved: {
    resourceId: string;
    version: string;
    role: AgentCombinationResourceRole;
    required: boolean;
    kind: CapabilityRecord['kind'];
    name: string;
  }[];
}

export interface AgentCombinationDocument {
  version: number;
  combinations: AgentCombination[];
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const GRADES = new Set<ModelGrade>(['low', 'medium', 'high', 'highest']);
const ROLES = new Set<AgentCombinationResourceRole>(['identity', 'tool', 'skill', 'mcp', 'pi-extension', 'extension']);

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
      const version = resource.version === undefined ? undefined : text(resource.version, `combinations[${index}].resources[${resourceIndex}].version`);
      const seenKey = `${role}:${resourceId}@${version ?? 'current'}`;
      if (seen.has(seenKey)) throw new RuntimeError('invalid_agent_combination', `Agent combination ${id} repeats ${resourceId} in role ${role}`);
      seen.add(seenKey);
      return {
        resourceId,
        role,
        required: resource.required !== false,
        ...(version ? { version } : {}),
      };
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

export async function readAgentCombinations(path: string): Promise<AgentCombinationDocument> {
  if (!existsSync(path)) return { version: 1, combinations: [] };
  try {
    return parseAgentCombinations(JSON.parse(await readFile(path, 'utf8')) as Json);
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('invalid_agent_combination', `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writeAgentCombinations(path: string, document: AgentCombinationDocument): Promise<void> {
  const parsed = parseAgentCombinations(document);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function expectedKind(role: AgentCombinationResourceRole): CapabilityRecord['kind'] {
  if (role === 'identity' || role === 'tool') return 'prompt';
  if (role === 'pi-extension') return 'pi-extension';
  if (role === 'extension') return 'extension';
  return role;
}

function selectCapability(members: CapabilityRecord[], member: AgentCombinationResource) {
  const candidates = members.filter(item => item.id === member.resourceId && item.status === 'available'
    && (!member.version || item.version === member.version));
  if (!candidates.length) return undefined;
  return candidates[candidates.length - 1];
}

function roleMatches(record: CapabilityRecord, role: AgentCombinationResourceRole) {
  if (expectedKind(role) !== record.kind) return false;
  if (role === 'identity') return record.role === 'agent';
  if (role === 'tool') return record.role === 'tool';
  return true;
}

export function validateAgentCombination(
  combination: AgentCombination,
  capabilities: CapabilityRecord[],
): AgentCombinationView {
  const issues: string[] = [];
  const resolved: AgentCombinationView['resolved'] = [];
  let identityCount = 0;
  let toolCount = 0;
  for (const member of combination.resources) {
    const record = selectCapability(capabilities, member);
    if (!record) {
      if (member.required) issues.push(`Missing required capability ${member.resourceId}${member.version ? `@${member.version}` : ''} (${member.role})`);
      continue;
    }
    if (!roleMatches(record, member.role)) {
      const detail = `Capability ${record.id}@${record.version} is ${record.kind}${record.role ? `/${record.role}` : ''}, not ${member.role}`;
      if (member.required) issues.push(detail);
      continue;
    }
    if (member.role === 'identity') identityCount += 1;
    if (member.role === 'tool') toolCount += 1;
    if (member.role === 'identity' && identityCount > 1) issues.push(`Agent combination ${combination.id} has more than one identity prompt`);
    if (member.role === 'tool' && toolCount > 1) issues.push(`Agent combination ${combination.id} has more than one tool prompt`);
    resolved.push({
      resourceId: record.id,
      version: record.version,
      role: member.role,
      required: member.required,
      kind: record.kind,
      name: record.name ?? record.id,
    });
  }
  if (toolCount && !identityCount) issues.push(`Agent combination ${combination.id} binds a tool prompt without an identity prompt`);
  return { ...combination, status: issues.length ? 'invalid' : 'valid', issues, resolved };
}

export function compileAgentCombinationDefinition(
  combination: AgentCombination,
  capabilities: CapabilityRecord[],
): { definition: DefinitionSpec; view: AgentCombinationView } {
  const view = validateAgentCombination(combination, capabilities);
  if (view.status !== 'valid') {
    throw new RuntimeError('invalid_agent_combination', view.issues.join('; '));
  }
  const definition: DefinitionSpec = {
    recommendedGrade: combination.recommendedGrade,
    ...(combination.review ? { review: true } : {}),
    snapshot: {
      agentCombination: {
        id: combination.id,
        name: combination.name,
        description: combination.description,
        tags: combination.tags,
      },
    } as Json,
  };
  const executable: { id: string; version: string }[] = [];
  for (const member of view.resolved) {
    const binding = { id: member.resourceId, version: member.version };
    if (member.role === 'identity') definition.prompts = { ...(definition.prompts ?? {}), agent: binding };
    else if (member.role === 'tool') definition.prompts = { ...(definition.prompts ?? {}), tool: binding };
    else executable.push(binding);
  }
  if (executable.length) definition.capabilities = executable;
  return { definition, view };
}
