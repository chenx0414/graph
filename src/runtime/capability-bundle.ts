import { createHash } from 'node:crypto';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Catalog } from '../catalog/catalog.ts';
import { canonicalJson } from '../core/store.ts';
import type { ResolvedAccessPolicy } from '../core/access-policy.ts';
import { selectAgentToolSurface } from './pi-native-tools.ts';
import {
  capabilityPrompts,
  loadCapabilities,
  resolveCapabilityFacts,
  type CapabilityPermissionRequest,
  type LoadedCapabilities,
  type ResolvedCapabilityFact,
} from './capabilities.ts';
import type { SendGate } from './controlled-openai.ts';

function digest(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export interface CapabilityBundleOptions {
  catalog: Catalog;
  definitionVersion?: string;
  bootstrap?: { agent?: string; tool?: string };
  mcpDomains?: string[];
  secrets?: () => Record<string, string>;
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

export interface CapabilityOperation {
  readonly bundleDigest: string;
  readonly toolPolicyDigest: string;
  readonly runtimePolicyDigest: string;
  readonly legacyPromptDigest: string;
  readonly tools: readonly ToolDefinition[];
  readonly nativeTools: readonly string[];
  readonly allowedToolNames: readonly string[];
  readonly prompts: { system: string; appendSystem: string };
  readonly report: LoadedCapabilities['report'];
  readonly skillPaths: readonly string[];
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
  private readonly input: CapabilityBundleOptions;

  private constructor(
    input: CapabilityBundleOptions,
    facts: ResolvedCapabilityFact[],
  ) {
    this.input = input;
    this.definitionVersion = input.definitionVersion ?? null;
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
    return new CapabilityBundleVersion(options, facts);
  }

  async openOperation(options: CapabilityOperationOptions): Promise<CapabilityOperation> {
    let loaded: LoadedCapabilities | undefined;
    try {
      loaded = await loadCapabilities({
        catalog: this.input.catalog,
        ...(this.input.definitionVersion ? { definitionVersion: this.input.definitionVersion } : {}),
        workspace: options.workspace,
        scratchDir: options.scratchDir,
        gate: options.gate,
        ...(this.input.bootstrap ? { bootstrap: this.input.bootstrap } : {}),
        ...(this.input.mcpDomains?.length ? { mcpDomains: this.input.mcpDomains } : {}),
        ...(this.input.secrets ? { secrets: this.input.secrets() } : {}),
        ...(options.grants ? { grants: options.grants } : {}),
        ...(options.readOnly ? { readOnly: true } : {}),
        ...(options.onPermissionRequired ? { onPermissionRequired: options.onPermissionRequired } : {}),
        ...(options.access ? { access: options.access } : {}),
      });
      const readRoots = Object.freeze([...new Set([...loaded.readRoots, ...(options.additionalReadRoots ?? [])])]);
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
      const report = loaded.report.map(fact => fact.tools
        ? { ...fact, tools: fact.tools.filter(name => !disabledTools.has(name)) }
        : fact);
      const prompts = capabilityPrompts({
        definitionVersion: this.definitionVersion ?? 'unknown@1',
        action: options.action,
        ...(options.role ? { role: options.role } : {}),
        agentPrompt: loaded.prompts.agent,
        toolPrompt: loaded.prompts.tool,
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
        bundleDigest: this.digest,
        toolPolicyDigest,
        runtimePolicyDigest,
        legacyPromptDigest: prompts.digest,
        tools,
        nativeTools,
        allowedToolNames,
        prompts: {
          system: prompts.systemPrompt,
          appendSystem: prompts.appendSystemPrompt,
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
