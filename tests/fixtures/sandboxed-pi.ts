import { Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { createAssistantMessageEventStream, InMemoryCredentialStore, type Api, type Model } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { openPiInstance } from '../../src/runtime/pi-instance.ts';

const [workspace, modelJson] = process.argv.slice(2) as [string, string];
const model = JSON.parse(modelJson) as Model<Api>;
const channel = new Socket({ fd: 3, readable: true, writable: true });
const lines = createInterface({ input: channel })[Symbol.asyncIterator]();
const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
runtime.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: 'broker-placeholder-no-real-credential', models: [model] });
const instance = await openPiInstance({
  workspace, stateDir: `${workspace}/session`, binding: { instanceId: 'agent-1', nodeId: 'node-1', definitionVersion: 'coder@1' },
  model, modelRuntime: runtime,
  stream: async (_model, context) => {
    channel.write(JSON.stringify({ operation: 'model', context }) + '\n');
    const reply = JSON.parse((await lines.next()).value!);
    if (!reply.ok) throw new Error(reply.error);
    const output = createAssistantMessageEventStream();
    const message = reply.value;
    if (message.stopReason === 'error' || message.stopReason === 'aborted') output.push({ type: 'error', reason: message.stopReason, error: message });
    else output.push({ type: 'done', reason: message.stopReason, message });
    return output;
  },
});
await instance.prompt('Persist this request in the restricted Pi worker');
console.log(JSON.stringify(instance.inspect()));
await instance.close();
channel.destroy();
