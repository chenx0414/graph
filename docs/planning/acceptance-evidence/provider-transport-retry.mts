// Local-only transport regression probe for Graph commit 2841c4d.
// Exit 0 means the observation completed; see the acceptance report for expected behavior.
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CallBroker } from '../../../src/runtime/call-broker.ts';
import { controlledOpenAIStream } from '../../../src/runtime/controlled-openai.ts';

for (const pauseOnReset of [true, false]) {
  const root = await mkdtemp(join(tmpdir(), 'graph-review-reset-'));
  const broker = new CallBroker(join(root, 'calls.sqlite'), 'agent-1');
  const acceptedBodies: object[] = [];
  let afterPause = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    acceptedBodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    if (pauseOnReset && acceptedBodies.length > 1) afterPause++;
    if (acceptedBodies.length === 1) {
      // Server has received and processed the complete provider request before the connection drops.
      if (pauseOnReset) broker.pause();
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'r', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'ready' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 10 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const model = {
      id: 'local', name: 'local', provider: 'graph-openai', api: 'openai-completions' as const,
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      reasoning: false, input: ['text' as const], contextWindow: 32_000, maxTokens: 256,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const stream = await controlledOpenAIStream(broker, 'local-only')(model, { messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }] });
    const result = await stream.result();
    const state = broker.inspect();
    console.log(JSON.stringify({ pauseOnReset, acceptedRequests: acceptedBodies.length, afterPause, identicalBodies: JSON.stringify(acceptedBodies[0]) === JSON.stringify(acceptedBodies[1]), stopReason: result.stopReason, status: state.status, hold: state.hold, used: state.used, invocationCount: state.calls.length, invocationStates: state.calls.map(call => call.state) }));
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    broker.close();
    await rm(root, { recursive: true, force: true });
  }
}
