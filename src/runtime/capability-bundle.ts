import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Catalog } from '../catalog/catalog.ts';
import { canonicalJson } from '../core/store.ts';
import type { ResolvedAccessPolicy } from '../core/access-policy.ts';
import { selectAgentToolSurface } from './pi-native-tools.ts';
import { agentSkills, agentSkillsDir, syncAgentSkills } from './agent-skills.ts';
import {
  capabilityPrompts,
  loadCapabilities,
  resolveCapabilityFacts,
  type CapabilityLoadFact,
  type CapabilityPermissionRequest,
  type LoadedCapabilities,
  type ResolvedCapabilityFact,
} from './capabilities.ts';
import type { SendGate } from './controlled-openai.ts';

function digest(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * The Agent's skills folder. The caller may point it somewhere else, but by default it is
 * the recipe's own folder next to the capability library, so a definition with skills
 * always has one.
 */
function skillFolderFor(options: CapabilityBundleOptions): string | null {
  const agentId = options.definitionVersion?.split('@')[0];
  const capabilityRoot = options.catalog.capabilityRootPath();
  return options.skillFolder
    ?? (agentId && capabilityRoot ? agentSkillsDir(agentId, resolve(capabilityRoot, '..')) : null);
}

export interface CapabilityBundleOptions {
  catalog: Catalog;
  definitionVersion?: string;
  bootstrap?: { agent?: string; tool?: string };
  mcpDomains?: string[];
  secrets?: () => Record<string, string>;
  /**
   * The Agent's own skills folder. Bound skills are mirrored into it as symlinks and the
   * SDK loads skills from it, so a hand-edited folder is a first-class input.
   */
  skillFolder?: string;
  /**
   * Working directory whose `.pi/skills` and `.agents/skills` are project sources, exactly
   * as the SDK defines the first one. The global sources are the SDK's own agent directory
   * and the home `.agents` folder.
   */
  skillCwd?: string;
  /** The bound project's root, so its `.pi`/`.agents` skills reach every Agent, not only
   * the one whose working directory happens to be the project root. */
  skillProjectRoot?: string;
  /** Capability roots Graph owns; links pointing into them are Graph's own to manage. */
  skillOwnedRoots?: readonly string[];
}

export interface CapabilityOperationOptions {
  workspace: string;
  scratchDir: string;
  gate: SendGate;
  action: string;
  role?: string;
  readOnly?: boolean;
  grants?: string[];
  /** Host-selected read-only roots outside the workspace, such as the user's capability library. */
  additionalReadRoots?: string[];
  /** Effective access policy frozen for this operation. */
  access?: ResolvedAccessPolicy;
  /** User-selected main-Agent tools that must not be offered to this operation. */
  disabledTools?: readonly string[];
  /** Pi-native tools enabled for this operation. Host tools with the same name are not registered. */
  nativeTools?: readonly string[];
  onPermissionRequired?: (request: CapabilityPermissionRequest) => void;
  hostTools(input: { readRoots: readonly string[] }): ToolDefinition[];
}

export type FrozenCapabilitySetting =
  | { kind: 'literal'; value: null | boolean | number }
  | { kind: 'string'; parts: (string | { credential: string })[] }
  | { kind: 'array'; items: FrozenCapabilitySetting[] }
  | { kind: 'object'; properties: Record<string, FrozenCapabilitySetting> };

function freezeSettings(value: unknown, credentials: Record<string, string>): FrozenCapabilitySetting {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return { kind: 'literal', value };
  if (typeof value === 'string') {
    const candidates = Object.entries(credentials).filter(([, text]) => text.length > 0).sort((a, b) => b[1].length - a[1].length);
    const parts: (string | { credential: string })[] = [];
    let rest = value;
    while (rest.length) {
      let match: { index: number; name: string; text: string } | undefined;
      for (const [name, text] of candidates) {
        const index = rest.indexOf(text);
        if (index >= 0 && (!match || index < match.index)) match = { index, name, text };
      }
      if (!match) { parts.push(rest); break; }
      if (match.index) parts.push(rest.slice(0, match.index));
      parts.push({ credential: match.name });
      rest = rest.slice(match.index + match.text.length);
    }
    return { kind: 'string', parts };
  }
  if (Array.isArray(value)) return { kind: 'array', items: value.map(item => freezeSettings(item, credentials)) };
  if (typeof value === 'object') return { kind: 'object', properties: Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, freezeSettings(item, credentials)])) };
  throw new Error('Capability setting is not serializable');
}

/** Rebind the same named credentials while retaining every literal setting. */
export function restoreCapabilitySettings(value: FrozenCapabilitySetting, credentials: Record<string, string>): unknown {
  switch (value.kind) {
    case 'literal': return value.value;
    case 'string': return value.parts.map(part => {
      if (typeof part === 'string') return part;
      if (credentials[part.credential] === undefined) throw new Error(`Frozen capability requires credential ${part.credential}`);
      return credentials[part.credential];
    }).join('');
    case 'array': return value.items.map(item => restoreCapabilitySettings(item, credentials));
    case 'object': return Object.fromEntries(Object.entries(value.properties).map(([key, item]) => [key, restoreCapabilitySettings(item, credentials)]));
  }
}

export interface CapabilityOperation {
  /** Serializable resolved versions, sources and credential-reference manifests;
   * function closures and resolved secret values remain with the live operation. */
  readonly descriptor: { definitionVersion: string | null; facts: readonly ResolvedCapabilityFact[]; settings: FrozenCapabilitySetting };

  readonly bundleDigest: string;
  readonly toolPolicyDigest: string;
  readonly runtimePolicyDigest: string;
  readonly legacyPromptDigest: string;
  readonly tools: readonly ToolDefinition[];
  readonly nativeTools: readonly string[];
  readonly allowedToolNames: readonly string[];
  readonly prompts: { system: string; tool: string | null };
  readonly report: LoadedCapabilities['report'];
  readonly skillPaths: readonly string[];
  /** The Agent's skills folder the SDK loads from; null when this bundle has none. */
  readonly skillFolder: string | null;
  readonly readRoots: readonly string[];
  readonly writeRoots: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly networkDomains: readonly string[];
  readonly allowUnrestrictedNetwork: boolean;
  readonly allowLocalBinding: boolean;
  readonly unixSockets: readonly string[];
  readonly piExtensionPaths: readonly string[];
  readonly piExtensionTools: readonly string[];
  close(): Promise<void>;
}

export class CapabilityBundleVersion {
  readonly definitionVersion: string | null;
  readonly digest: string;
  readonly toolPolicyDigest: string;
  readonly runtimePolicyDigest: string;
  readonly facts: readonly ResolvedCapabilityFact[];
  /** The Agent's skills folder the SDK loads from; null when there is no capability root. */
  readonly skillFolder: string | null;
  private readonly input: CapabilityBundleOptions;

  private constructor(
    input: CapabilityBundleOptions,
    facts: ResolvedCapabilityFact[],
  ) {
    this.input = input;
    this.definitionVersion = input.definitionVersion ?? null;
    this.skillFolder = skillFolderFor(input);
    this.facts = Object.freeze(facts.map(fact => structuredClone(fact)));
    const staticToolPolicy = {
      piExtensionTools: this.facts.flatMap(fact =>
        (fact.declaredTools ?? []).map(tool => ({
          capabilityId: fact.id,
          capabilityVersion: fact.version,
          name: tool.name,
          description: tool.description,
        })))
        .sort((left, right) =>
          `${left.capabilityId}@${left.capabilityVersion}:${left.name}`.localeCompare(`${right.capabilityId}@${right.capabilityVersion}:${right.name}`)),
    };
    const runtimePolicy = {
      capabilities: this.facts.map(fact => ({
        id: fact.id,
        version: fact.version,
        kind: fact.kind,
        role: fact.role ?? null,
        digest: fact.digest,
        declaredTools: fact.declaredTools ?? [],
        networkDomains: fact.networkDomains ?? [],
        networkAccess: fact.networkAccess ?? null,
        provisioning: fact.provisioning ?? null,
      })),
    };
    this.toolPolicyDigest = digest(staticToolPolicy);
    this.runtimePolicyDigest = digest(runtimePolicy);
    this.digest = digest({
      definitionVersion: this.definitionVersion,
      toolPolicyDigest: this.toolPolicyDigest,
      runtimePolicyDigest: this.runtimePolicyDigest,
    });
  }

  static async open(options: CapabilityBundleOptions) {
    const facts = await resolveCapabilityFacts(options.catalog, options.definitionVersion);
    // Mirror this definition's bound skills into the Agent's folder before anything reads
    // it, so the console preview and the real operation see the same folder.
    const skillFolder = skillFolderFor(options);
    if (skillFolder) {
      syncAgentSkills({
        dir: skillFolder,
        ownedRoots: options.skillOwnedRoots ?? [],
        links: facts.flatMap(fact => fact.kind === 'skill' && fact.path
          ? [{ id: fact.id, target: dirname(fact.path) }]
          : []),
      });
    }
    return new CapabilityBundleVersion(options, facts);
  }

  async openOperation(options: CapabilityOperationOptions): Promise<CapabilityOperation> {
    let loaded: LoadedCapabilities | undefined;
    const credentialBindings = this.input.secrets?.() ?? {};
    try {
      loaded = await loadCapabilities({
        catalog: this.input.catalog,
        ...(this.input.definitionVersion ? { definitionVersion: this.input.definitionVersion } : {}),
        workspace: options.workspace,
        scratchDir: options.scratchDir,
        gate: options.gate,
        ...(this.input.bootstrap ? { bootstrap: this.input.bootstrap } : {}),
        ...(this.input.mcpDomains?.length ? { mcpDomains: this.input.mcpDomains } : {}),
        ...(this.input.secrets ? { secrets: credentialBindings } : {}),
        ...(options.grants ? { grants: options.grants } : {}),
        ...(options.readOnly ? { readOnly: true } : {}),
        ...(options.onPermissionRequired ? { onPermissionRequired: options.onPermissionRequired } : {}),
        ...(options.access ? { access: options.access } : {}),
      });
      const readRoots = Object.freeze([...new Set([...loaded.readRoots, ...(options.additionalReadRoots ?? [])])]);
      // A bound skill's path only exists in the load facts, so mirror them here as well:
      // this is the folder the SDK and the prompt read for this operation.
      if (this.skillFolder) {
        syncAgentSkills({
          dir: this.skillFolder,
          ownedRoots: this.input.skillOwnedRoots ?? [],
          links: loaded.report.flatMap(fact => fact.kind === 'skill' && fact.path
            ? [{ id: fact.id, target: dirname(fact.path) }]
            : []),
        });
      }
      const disabledTools = new Set((options.disabledTools ?? []).map(name => name.trim()).filter(Boolean));
      const selected = selectAgentToolSurface({
        tools: [...options.hostTools({ readRoots }), ...loaded.tools],
        nativeTools: options.nativeTools ?? [],
        disabledTools: options.disabledTools ?? [],
        extensionTools: loaded.piExtensionTools,
      });
      const nativeTools = Object.freeze(selected.nativeTools);
      const tools = Object.freeze(selected.tools);
      const piExtensionTools = selected.extensionTools;
      // Skills are recorded from the folders the SDK loads: the Agent's own folder, which
      // is where bound skills are mirrored and where the user pastes their own, plus the
      // SDK's global and project folders. A bound skill keeps its loaded fact and its
      // version, a skill found in any of those folders becomes a load fact of its own, and
      // everything else stays as loaded.
      const folderSkills = agentSkills({
        ...(this.skillFolder ? { folder: this.skillFolder } : {}),
        ...(this.input.skillCwd ? { cwd: this.input.skillCwd } : {}),
        ...(this.input.skillProjectRoot ? { projectRoot: this.input.skillProjectRoot } : {}),
      }).skills;
      const excludedSkills = new Set(folderSkills.filter(skill => skill.disableModelInvocation).map(skill => skill.name));
      const recordedSkills = new Set(loaded.report.filter(fact => fact.kind === 'skill').map(fact => fact.id));
      const pastedSkills = folderSkills.filter(skill => !recordedSkills.has(skill.name));
      const report = [
        ...loaded.report,
        ...pastedSkills.map((skill): CapabilityLoadFact => ({
          id: skill.name,
          version: 'local',
          kind: 'skill',
          name: skill.name,
          description: skill.description,
          path: skill.filePath,
          loaded: true,
          executable: false,
          reason: '原生 skills 注入：模型按需读取 SKILL.md',
        })),
      ].map(fact => {
        const kept = fact.tools ? { ...fact, tools: fact.tools.filter(name => !disabledTools.has(name)) } : fact;
        // The native formatter drops a skill that declares disable-model-invocation, so the
        // fact must say that instead of claiming the model can read it.
        return kept.kind === 'skill' && excludedSkills.has(kept.name ?? kept.id)
          ? { ...kept, reason: '声明了 disable-model-invocation：不会进入系统提示（原生语义为仅显式调用）' }
          : kept;
      });
      const prompts = capabilityPrompts({
        definitionVersion: this.definitionVersion ?? 'unknown@1',
        action: options.action,
        ...(options.role ? { role: options.role } : {}),
        agentPrompt: loaded.prompts.agent,
        report,
        tools,
      });
      const effectiveToolPolicy = {
        bundleDigest: this.digest,
        readOnly: Boolean(options.readOnly),
        grants: [...new Set(options.grants ?? [])].sort(),
        tools: tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters as unknown,
        })),
        nativeTools,
        piExtensionTools: [...piExtensionTools].sort(),
      };
      const toolPolicyDigest = digest(effectiveToolPolicy);
      const runtimePolicyDigest = digest({
        bundleRuntimePolicyDigest: this.runtimePolicyDigest,
        accessPolicyDigest: options.access?.digest ?? null,
        readOnly: Boolean(options.readOnly),
        piExtensionRuntime: {
          env: loaded.env,
          readRoots,
          writeRoots: loaded.writeRoots,
          networkDomains: loaded.networkDomains,
          allowUnrestrictedNetwork: loaded.allowUnrestrictedNetwork,
          allowLocalBinding: loaded.allowLocalBinding,
          unixSockets: loaded.unixSockets,
        },
      });
      const allowedToolNames = Object.freeze([...new Set([
        ...tools.map(tool => tool.name),
        ...nativeTools,
        ...piExtensionTools,
      ])].sort());
      const operation: CapabilityOperation = {
        descriptor: Object.freeze({ definitionVersion: this.definitionVersion ?? null, facts: Object.freeze(this.facts.map(fact => Object.freeze({ ...fact }))), settings: freezeSettings({ env: loaded.env }, credentialBindings) }),
        bundleDigest: this.digest,
        toolPolicyDigest,
        runtimePolicyDigest,
        legacyPromptDigest: prompts.digest,
        tools,
        nativeTools,
        allowedToolNames,
        prompts: {
          system: prompts.systemPrompt,
          tool: loaded.prompts.tool,
        },
        report,
        skillPaths: Object.freeze([...loaded.skillPaths]),
        readRoots,
        writeRoots: Object.freeze([...loaded.writeRoots]),
        env: Object.freeze({ ...loaded.env }),
        networkDomains: Object.freeze([...loaded.networkDomains]),
        allowUnrestrictedNetwork: loaded.allowUnrestrictedNetwork,
        allowLocalBinding: loaded.allowLocalBinding,
        unixSockets: Object.freeze([...loaded.unixSockets]),
        skillFolder: this.skillFolder,
        piExtensionPaths: Object.freeze([...loaded.piExtensionPaths]),
        piExtensionTools: Object.freeze([...piExtensionTools]),
        close: () => loaded!.close(),
      };
      return Object.freeze(operation);
    } catch (error) {
      await loaded?.close().catch(() => undefined);
      throw error;
    }
  }
}

export function openCapabilityBundle(options: CapabilityBundleOptions) {
  return CapabilityBundleVersion.open(options);
}
