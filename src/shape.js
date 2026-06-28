// Shape bridge text (already restored) into each client protocol — both a
// non-streaming body and an SSE event sequence. Used only by the bridge backend,
// where the gateway synthesizes the provider response itself.
//
// Each shaper exposes:
//   contentType            'application/json' | 'text/event-stream'
//   full(text)        -> string   non-streaming JSON body
//   sseHead()         -> string   opening SSE events (may be '')
//   sseDelta(text)    -> string   one chunk of text
//   sseTail()         -> string   closing SSE events

function id(prefix) {
  // Runtime (not a workflow) — Date.now()/random are fine here.
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
const now = () => Math.floor(Date.now() / 1000);
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const event = (name, obj) => `event: ${name}\n` + sse(obj);

export function openaiChat(model) {
  const rid = id('chatcmpl');
  const base = { id: rid, object: 'chat.completion.chunk', created: now(), model };
  return {
    contentType: 'application/json',
    full(text) {
      return JSON.stringify({
        id: rid, object: 'chat.completion', created: now(), model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: {},
      });
    },
    sseHead() {
      return sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    },
    sseDelta(text) {
      return sse({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
    },
    sseTail() {
      return sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n';
    },
    // Tool-relay (agent destinations): emit the agent's tool call as an OpenAI
    // tool_calls delta, then end the turn with finish_reason:tool_calls.
    sseToolCalls(calls) {
      return sse({ ...base, choices: [{ index: 0, delta: { tool_calls: calls.map((c, i) => ({ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) }, finish_reason: null }] });
    },
    sseToolFinish() {
      return sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n';
    },
  };
}

export function openaiResponses(model) {
  const rid = id('resp');
  return {
    contentType: 'application/json',
    full(text) {
      return JSON.stringify({
        id: rid, object: 'response', created_at: now(), model, status: 'completed',
        output: [{ id: id('msg'), type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
        output_text: text,
      });
    },
    sseHead() {
      return event('response.created', { type: 'response.created', response: { id: rid, status: 'in_progress', model } });
    },
    sseDelta(text) {
      return event('response.output_text.delta', { type: 'response.output_text.delta', delta: text });
    },
    sseTail() {
      return event('response.completed', { type: 'response.completed', response: { id: rid, status: 'completed', model } });
    },
  };
}

export function anthropicMessages(model) {
  const rid = id('msg');
  return {
    contentType: 'application/json',
    full(text) {
      return JSON.stringify({
        id: rid, type: 'message', role: 'assistant', model,
        content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: {},
      });
    },
    sseHead() {
      return event('message_start', { type: 'message_start', message: { id: rid, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: {} } })
        + event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    },
    sseDelta(text) {
      return event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    },
    sseTail() {
      return event('content_block_stop', { type: 'content_block_stop', index: 0 })
        + event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} })
        + event('message_stop', { type: 'message_stop' });
    },
  };
}

// Pick a shaper for a parsed request + its adapter name.
export function shaperFor(kind, model) {
  if (kind === 'anthropic') return anthropicMessages(model);
  if (kind === 'responses') return openaiResponses(model);
  return openaiChat(model);
}
