import { Ajv, type ValidateFunction } from 'ajv';
import { expandSubgraph } from './subgraph.ts';
import { RuntimeError } from './types.ts';
import type { Json } from './types.ts';

/**
 * Graph v2 declarative interface (Issue #1 §3–§4, §15.1–§15.2).
 *
 * This module is the single formal definition format for the new kernel. JSON is
 * the only accepted syntax: the YAML in the spec is documentation, never an
 * import path. A definition is parsed whole — any defect refuses the whole
 * definition so a partially accepted graph can never exist (§15.9, "禁止部分创建成功").
 *
 * Kept deliberately separate from the legacy `Proposal`/`NodeSpec` shape in
 * `types.ts`: the old DAG fields (dependsOn/when/loops) stay readable for history
 * only and are never mixed into this structure.
 */

export const INTERFACE_SCHEMA_VERSION = 2;

/** A JSON-schema-shaped protocol declaration. The target input is the receiving authority (§4). */
export interface ProtocolSpec {
  type: string;
  version?: number;
  required?: string[];
  properties?: Record<string, Json>;
  [key: string]: Json | undefined;
}

export interface ProtocolRef {
  protocol: string;
  /** Explicit version the endpoint promises. Omitted means the protocol's base (v1) declaration. */
  version?: number;
}

export interface NodeInterface {
  /** Named logical inputs, each bound to a protocol. */
  inputs: Record<string, ProtocolRef>;
  /** Named logical outputs, each bound to a protocol. */
  outputs: Record<string, ProtocolRef>;
}

export interface NodeDefinition extends NodeInterface {
  /**
   * Either a recipe (an Agent node) or a command (a deterministic one).
   *
   * A graph needs both: some nodes think, and some run the same command every time. Before
   * this, a deterministic node had to be spelled as an Agent with a recipe, which made it
   * look like work that needed a model and a session — and lifted old graphs ran their
   * checks as if they were agents.
   */
  recipe?: string;
  /** A deterministic node: the command to run, and its arguments. */
  command?: { run: string; args?: string[]; timeoutMs?: number };
  task: string;
  acceptance?: string[];
  /** Required outputs a submission must enable:true (§4). */
  submission: { required?: string[]; requiredAnyOf?: string[] };
  /**
   * A file this node promises to produce. The kernel publishes it as a task-scope
   * artifact when the node's execution completes, so the promise does not depend on the
   * node remembering a tool call, and a declared file that was never written (or is
   * empty) fails the node instead of passing silently.
   */
  deliverable?: {
    /** Path relative to the node's workspace; it may not escape it. */
    path: string;
    namespace: 'plans' | 'research' | 'reviews' | 'deliverables' | 'summaries';
    name: string;
    title?: string;
    summary?: string;
  };
}

export interface ModuleDefinition {
  type: 'router' | 'command' | 'operation';
  trigger: 'each' | 'once';
  inputs: Record<string, ProtocolRef>;
  outputs: Record<string, ProtocolRef>;
  /** once-modules must name the inputs a rule needs, so a missing field is never read as false (§4). */
  requiredInputs?: string[];
  /** An explicit input which only clears the once latch; held values remain. */
  control?: { reopen: string };
  limits?: { timeoutMs?: number; memoryMb?: number; inputBytes?: number; outputBytes?: number; stateBytes?: number };
  rules?: ModuleRule[];
  /**
   * A command module's main-authored code (§9): an entry file exporting
   * `evaluate({inputs,state,trigger})`, plus the version this instance runs. The
   * code is never imported into the daemon; it runs in the isolated module process.
   */
  code?: { entry: string; version: number };
  /** Trusted host operation; it shares input, latch and delivery semantics with routers. */
  operation?: { action: 'workspace.command'; version: number; command: string; args: string[];
    output: string; timeoutMs?: number; sandbox?: boolean };

}

export interface ModuleRule {
  when: string;
  emit: Record<string, Json>;
}

export interface EdgeDefinition {
  from: string;
  to: string;
  enabled: boolean;
}

export interface GraphIo {
  to: string;
  protocol: string;
  version?: number;
}

export interface GraphOutput {
  from: string;
  protocol: string;
  version?: number;
}

export interface CompletionDeclaration {
  on: string;
  drain?: boolean;
}

export interface GraphDefinition {
  schemaVersion: number;
  name: string;
  protocols: Record<string, ProtocolSpec>;
  nodes: Record<string, NodeDefinition>;
  modules: Record<string, ModuleDefinition>;
  edges: Record<string, EdgeDefinition>;
  inputs: Record<string, GraphIo>;
  outputs: Record<string, GraphOutput>;
  completion?: CompletionDeclaration;
  /** True when a subgraph was expanded: its public io is mapped in, never scheduled separately (§9). */
  subgraphs?: string[];
  templates?: Record<string, { version: number; definition: GraphDefinition }>;
  instances?: Record<string, { template: string; version: number }>;
  subgraphInstances?: Record<string, { template: string; version: number; inputs: Record<string, GraphIo>; outputs: Record<string, GraphOutput> }>;

}

const invalid = (reason: string): never => { throw new RuntimeError('invalid_definition', reason); };

const isRecord = (value: unknown): value is Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `node.port` endpoint syntax shared by edges.io and graph io. */
function splitEndpoint(endpoint: string): { owner: string; port: string } {
  const dot = endpoint.indexOf('.');
  if (dot <= 0 || dot === endpoint.length - 1) invalid(`Endpoint ${endpoint} must be "<node>.<port>"`);
  return { owner: endpoint.slice(0, dot), port: endpoint.slice(dot + 1) };
}

/** The protocol ref an endpoint promises, resolved against the owning node's interface. */
function endpointRef(definition: GraphDefinition, endpoint: string, kind: 'input' | 'output'): ProtocolRef | undefined {
  const { owner, port } = splitEndpoint(endpoint);
  const node = definition.nodes[owner];
  if (node) return kind === 'input' ? node.inputs[port] : node.outputs[port];
  const module = definition.modules[owner];
  if (module) return kind === 'input' ? module.inputs[port] : module.outputs[port];
  return undefined;
}

const refVersion = (ref: ProtocolRef): number => ref.version ?? 1;

function protocolKey(ref: ProtocolRef): string {
  return `${ref.protocol}@${refVersion(ref)}`;
}

/**
 * §15.2: both ends of a connection must reference the same protocol id AND version.
 * A different protocol is not inferred by schema shape — it needs an explicit
 * mapping module. The actual value is still validated against all targets at submit.
 */
function assertSameProtocol(definition: GraphDefinition, from: ProtocolRef | undefined, to: ProtocolRef | undefined, where: string): void {
  if (!from) invalid(`${where} names an unknown source endpoint`);
  if (!to) invalid(`${where} names an unknown target endpoint`);
  if (protocolKey(from!) !== protocolKey(to!)) {
    invalid(`${where} connects ${protocolKey(from!)} to ${protocolKey(to!)}; both ends must reference the same protocol id and version`);
  }
  if (!definition.protocols[from!.protocol]) invalid(`${where} references undeclared protocol ${from!.protocol}`);
}

function assertDeclaredProtocol(definition: GraphDefinition, ref: ProtocolRef | undefined, where: string): void {
  if (!ref) return;
  if (!definition.protocols[ref.protocol]) invalid(`${where} references undeclared protocol ${ref.protocol}`);
}

function assertUniqueKeys(record: Record<string, unknown>, what: string): void {
  for (const key of Object.keys(record)) {
    if (!key.trim()) invalid(`${what} id must not be blank`);
  }
}

function validateNode(definition: GraphDefinition, id: string, node: NodeDefinition): void {
  if (!node || typeof node !== 'object') invalid(`Node ${id} must be an object`);
  const hasRecipe = typeof node.recipe === 'string' && node.recipe.trim().length > 0;
  const hasCommand = Boolean(node.command && typeof node.command.run === 'string' && node.command.run.trim());
  // Exactly one: a node is either something that thinks or a command that runs. Accepting
  // both would let a node silently behave like one of them.
  if (hasRecipe === hasCommand) invalid(`Node ${id} must declare exactly one of recipe or command`);
  if (hasCommand && node.command!.args !== undefined && !Array.isArray(node.command!.args)) invalid(`Node ${id} command args must be a list`);
  if (typeof node.task !== 'string' || !node.task.trim()) invalid(`Node ${id} requires a task`);
  for (const [port, ref] of Object.entries(node.inputs ?? {})) {
    assertDeclaredProtocol(definition, ref, `Node ${id} input ${port}`);
  }
  for (const [port, ref] of Object.entries(node.outputs ?? {})) {
    assertDeclaredProtocol(definition, ref, `Node ${id} output ${port}`);
  }
  for (const required of node.submission?.required ?? []) {
    if (!node.outputs?.[required]) invalid(`Node ${id} requires undeclared output ${required}`);
  }
  for (const anyOf of node.submission?.requiredAnyOf ?? []) {
    if (!node.outputs?.[anyOf]) invalid(`Node ${id} requiredAnyOf names undeclared output ${anyOf}`);
  }
  // A deliverable is a promise about a real file, so an unusable declaration must be
  // refused at creation rather than discovered as a failure minutes later.
  if (node.deliverable !== undefined) {
    const d = node.deliverable;
    if (!d || typeof d !== 'object') invalid(`Node ${id} deliverable must be an object`);
    const slug = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
    if (typeof d.path !== 'string' || !d.path.trim()) invalid(`Node ${id} deliverable requires a path`);
    // An absolute path or a walk out would point at a file the node was never entitled to
    // publish, so the declaration is refused instead of resolved later.
    if (d.path.startsWith('/') || d.path.split(/[\\/]/).some(part => part === '..' || part === '')) {
      invalid(`Node ${id} deliverable path must be a relative path inside the workspace`);
    }
    if (!['plans', 'research', 'reviews', 'deliverables', 'summaries'].includes(d.namespace)) {
      invalid(`Node ${id} deliverable namespace must be plans, research, reviews, deliverables or summaries`);
    }
    if (typeof d.name !== 'string' || !slug.test(d.name.toLowerCase())) invalid(`Node ${id} deliverable name must be a lowercase slug`);
  }
}

function validateModule(definition: GraphDefinition, id: string, module: ModuleDefinition): void {
  if (module.type !== 'router' && module.type !== 'command' && module.type !== 'operation') invalid(`Module ${id} has unsupported type ${String(module.type)}`);
  if (module.type === 'operation') {
    const operation = module.operation;
    if (!operation || operation.action !== 'workspace.command' || !Number.isSafeInteger(operation.version) || operation.version < 1
      || typeof operation.command !== 'string' || !operation.command.trim() || !Array.isArray(operation.args)
      || operation.args.some(arg => typeof arg !== 'string') || !module.outputs?.[operation.output]) invalid(`Module ${id} requires a versioned workspace.command operation and declared output`);
    if (operation!.timeoutMs !== undefined && (!Number.isSafeInteger(operation!.timeoutMs) || operation!.timeoutMs < 1 || operation!.timeoutMs > 86400000)) invalid(`Module ${id} has invalid operation timeout`);
    if (operation!.sandbox !== undefined && typeof operation!.sandbox !== 'boolean') invalid(`Module ${id} sandbox must be boolean`);
    if (module.code || module.rules?.length) invalid(`Module ${id} operation cannot also declare code or rules`);
  }
  if (module.trigger !== 'each' && module.trigger !== 'once') invalid(`Module ${id} trigger must be each or once`);
  for (const [port, ref] of Object.entries(module.inputs ?? {})) assertDeclaredProtocol(definition, ref, `Module ${id} input ${port}`);
  for (const [port, ref] of Object.entries(module.outputs ?? {})) assertDeclaredProtocol(definition, ref, `Module ${id} output ${port}`);
  for (const input of module.requiredInputs ?? []) {
    if (!module.inputs?.[input]) invalid(`Module ${id} requiredInputs names undeclared input ${input}`);
  }
  if (module.control && (!module.inputs[module.control.reopen] || module.requiredInputs?.includes(module.control.reopen))) {
    invalid(`Module ${id} reopen control must name an input excluded from requiredInputs`);
  }
  for (const [name, limit] of Object.entries(module.limits ?? {})) {
    if (!['timeoutMs', 'memoryMb', 'inputBytes', 'outputBytes', 'stateBytes'].includes(name) || !Number.isSafeInteger(limit) || limit < 1) invalid(`Module ${id} has invalid resource limit ${name}`);
    if (name === 'memoryMb' && (limit < 64 || limit > 16384)) invalid(`Module ${id} memoryMb must be between 64 and 16384`);
  }
  for (const [index, rule] of (module.rules ?? []).entries()) {
    if (typeof rule.when !== 'string' || !rule.when.trim()) invalid(`Module ${id} rule ${index} requires a when expression`);
    if (!isRecord(rule.emit)) invalid(`Module ${id} rule ${index} requires an emit map`);
    for (const port of Object.keys(rule.emit)) {
      if (!module.outputs?.[port]) invalid(`Module ${id} rule ${index} emits undeclared output ${port}`);
    }
  }
}

/** The single formal parse entry point. Whole-or-nothing. */
export function parseGraphDefinition(input: unknown, depth = 0): GraphDefinition {
  if (depth > 32) invalid('Subgraph expansion exceeds 32 levels or contains recursive definitions');
  if (!isRecord(input)) invalid('Definition must be a JSON object');
  const raw = input as Record<string, Json>;
  if (raw.schemaVersion !== INTERFACE_SCHEMA_VERSION) {
    invalid(`schemaVersion must be ${INTERFACE_SCHEMA_VERSION}; JSON is the only formal format`);
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) invalid('Definition requires a name');
  const protocols = raw.protocols ?? {};
  const nodes = raw.nodes ?? {};
  const modules = raw.modules ?? {};
  const edges = raw.edges ?? {};
  const inputs = raw.inputs ?? {};
  const outputs = raw.outputs ?? {};
  if (!isRecord(protocols) || !isRecord(nodes) || !isRecord(modules) || !isRecord(edges) || !isRecord(inputs) || !isRecord(outputs)) {
    invalid('protocols, nodes, modules, edges, inputs and outputs must be maps');
  }
  assertUniqueKeys(protocols as Record<string, unknown>, 'Protocol');
  assertUniqueKeys(nodes as Record<string, unknown>, 'Node');
  assertUniqueKeys(modules as Record<string, unknown>, 'Module');
  assertUniqueKeys(edges as Record<string, unknown>, 'Edge');
  const definition = {
    schemaVersion: INTERFACE_SCHEMA_VERSION,
    name: raw.name,
    protocols,
    nodes,
    modules,
    edges,
    inputs,
    outputs,
    ...(isRecord(raw.completion) ? { completion: raw.completion as unknown as CompletionDeclaration } : {}),
    ...(Array.isArray(raw.subgraphs) ? { subgraphs: raw.subgraphs as string[] } : {}),
    ...(isRecord(raw.subgraphInstances) ? { subgraphInstances: raw.subgraphInstances } : {}),
  } as unknown as GraphDefinition;

  if (raw.instances !== undefined) {
    if (!isRecord(raw.instances) || !isRecord(raw.templates)) invalid('Subgraph instances and templates must be maps');
    // Expansion owns its maps; parsing must never mutate a supplied template or graph.
    definition.nodes = { ...definition.nodes }; definition.modules = { ...definition.modules };
    definition.edges = { ...definition.edges }; definition.protocols = { ...definition.protocols };
    definition.inputs = structuredClone(definition.inputs); definition.outputs = structuredClone(definition.outputs);
    definition.subgraphInstances = { ...definition.subgraphInstances };
    for (const [id, value] of Object.entries(raw.instances as Record<string, Json>)) {
      if (!id || /[./]/.test(id) || definition.nodes[id] || definition.modules[id]) invalid(`Invalid or conflicting subgraph instance ${id}`);
      if (!isRecord(value) || typeof value.template !== 'string' || !Number.isSafeInteger(value.version) || Number(value.version) < 1) invalid(`Subgraph ${id} must pin a template and positive version`);
      const instanceRef = value as { template: string; version: number };
      const declaration = (raw.templates as Record<string, Json>)[instanceRef.template];
      if (!isRecord(declaration) || declaration.version !== instanceRef.version) invalid(`Subgraph ${id} template version is unavailable`);
      const template = parseGraphDefinition((declaration as Record<string, Json>).definition, depth + 1);
      const expanded = expandSubgraph({ instance: id, template, templateVersion: instanceRef.version });
      for (const [name, protocol] of Object.entries(template.protocols)) {
        if (definition.protocols[name] && JSON.stringify(definition.protocols[name]) !== JSON.stringify(protocol)) invalid(`Subgraph ${id} conflicts with protocol ${name}`);
        definition.protocols[name] = protocol;
      }
      for (const [name, node] of Object.entries(expanded.nodes)) {
        if (definition.nodes[name] || definition.modules[name]) invalid(`Duplicate expanded node ${name}`);
        definition.nodes[name] = node;
      }
      for (const [name, module] of Object.entries(expanded.modules)) {
        if (definition.nodes[name] || definition.modules[name]) invalid(`Duplicate expanded module ${name}`);
        definition.modules[name] = module;
      }
      for (const [name, edge] of Object.entries(expanded.edges)) {
        const key = `${id}/${name}`;
        if (definition.edges[key]) invalid(`Duplicate expanded edge ${key}`);
        definition.edges[key] = edge;
      }
      definition.subgraphInstances[id] = { template: instanceRef.template, version: instanceRef.version, inputs: expanded.inputs, outputs: expanded.outputs };
      for (const [nestedId, nested] of Object.entries(template.subgraphInstances ?? {})) {
        definition.subgraphInstances[`${id}/${nestedId}`] = {
          template: nested.template, version: nested.version,
          inputs: Object.fromEntries(Object.entries(nested.inputs).map(([port, io]) => [port, { ...io, to: `${id}/${io.to}` }])),
          outputs: Object.fromEntries(Object.entries(nested.outputs).map(([port, io]) => [port, { ...io, from: `${id}/${io.from}` }])),
        };
      }
    }
    const resolve = (reference: string, kind: 'input' | 'output'): string => {
      const dot = reference.indexOf('.');
      const instance = definition.subgraphInstances?.[reference.slice(0, dot)];
      if (!instance) return reference;
      const port = reference.slice(dot + 1);
      const mapped = kind === 'input' ? instance.inputs[port]?.to : instance.outputs[port]?.from;
      if (!mapped) invalid(`Unknown subgraph ${kind} ${reference}`);
      return mapped!;
    };
    for (const [name, edge] of Object.entries(definition.edges)) definition.edges[name] = { ...edge, from: resolve(edge.from, 'output'), to: resolve(edge.to, 'input') };
    for (const io of Object.values(definition.inputs)) io.to = resolve(io.to, 'input');
    for (const io of Object.values(definition.outputs)) io.from = resolve(io.from, 'output');
    definition.subgraphs = Object.keys(definition.subgraphInstances);
  }

  for (const [id, protocol] of Object.entries(definition.protocols)) {
    try { protocolValidator(protocol); } catch (error) { invalid(`Protocol ${id} has an invalid schema: ${error instanceof Error ? error.message : String(error)}`); }
  }

  for (const [id, node] of Object.entries(definition.nodes)) validateNode(definition, id, node);
  for (const [id, module] of Object.entries(definition.modules)) validateModule(definition, id, module);

  // Every edge connects a declared output to a declared input, with matching protocols.
  for (const [id, edge] of Object.entries(definition.edges)) {
    const from = endpointRef(definition, edge.from, 'output');
    const to = endpointRef(definition, edge.to, 'input');
    if (!from) invalid(`Edge ${id} names unknown output endpoint ${edge.from}`);
    if (!to) invalid(`Edge ${id} names unknown input endpoint ${edge.to}`);
    assertSameProtocol(definition, from, to, `Edge ${id}`);
  }

  // Graph-level public io maps onto declared node/module endpoints.
  for (const [name, io] of Object.entries(definition.inputs)) {
    const ref = endpointRef(definition, io.to, 'input');
    if (!ref) invalid(`Graph input ${name} names unknown endpoint ${io.to}`);
    assertSameProtocol(definition, { protocol: io.protocol, ...(io.version === undefined ? {} : { version: io.version }) }, ref, `Graph input ${name}`);
  }
  for (const [name, io] of Object.entries(definition.outputs)) {
    const ref = endpointRef(definition, io.from, 'output');
    if (!ref) invalid(`Graph output ${name} names unknown endpoint ${io.from}`);
    assertSameProtocol(definition, ref, { protocol: io.protocol, ...(io.version === undefined ? {} : { version: io.version }) }, `Graph output ${name}`);
  }

  if (definition.completion) {
    if (!definition.outputs[definition.completion.on]) {
      invalid(`completion.on names undeclared graph output ${definition.completion.on}`);
    }
  }
  return definition;
}

/** True when a protocol id is referenced anywhere in the given definition. */
export function protocolReferenced(definition: GraphDefinition, protocolId: string): boolean {
  if (definition.protocols[protocolId]) return true;
  const refs: (ProtocolRef | undefined)[] = [];
  for (const node of Object.values(definition.nodes)) refs.push(...Object.values(node.inputs ?? {}), ...Object.values(node.outputs ?? {}));
  for (const module of Object.values(definition.modules)) refs.push(...Object.values(module.inputs ?? {}), ...Object.values(module.outputs ?? {}));
  for (const io of Object.values(definition.inputs)) refs.push({ protocol: io.protocol, ...(io.version === undefined ? {} : { version: io.version }) });
  for (const io of Object.values(definition.outputs)) refs.push({ protocol: io.protocol, ...(io.version === undefined ? {} : { version: io.version }) });
  return refs.some(ref => ref?.protocol === protocolId);
}

const protocolAjv = new Ajv({ strict: false, strictSchema: true, validateFormats: false, addUsedSchema: false });
protocolAjv.addKeyword({ keyword: 'version', schemaType: 'number', valid: true });
const protocolValidators = new Map<string, ValidateFunction>();
function protocolValidator(spec: ProtocolSpec): ValidateFunction {
  const signature = JSON.stringify(spec);
  let validator = protocolValidators.get(signature);
  if (!validator) {
    validator = protocolAjv.compile(spec);
    if (protocolValidators.size >= 1000) protocolValidators.delete(protocolValidators.keys().next().value!);
    protocolValidators.set(signature, validator);
  }
  return validator;
}

/** The receiving protocol validates the actual value; validation never rewrites it. */
export function validateProtocolValue(spec: ProtocolSpec, value: Json, path = ''): string | null {
  try {
    const validate = protocolValidator(spec);
    if (validate(value)) return null;
    const error = validate.errors?.[0];
    return `${path || '(root)'}${error?.instancePath ?? ''}: ${error?.message ?? 'invalid value'}`;
  } catch (error) { return `${path || '(root)'}: invalid protocol schema: ${error instanceof Error ? error.message : String(error)}`; }
}
