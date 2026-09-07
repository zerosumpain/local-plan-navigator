// src/client/engines/webllm.worker.ts — a WebLLM engine behind the protocol.
//
// Runs in a Web Worker so the page stays responsive while the model loads
// and generates. The model weights come from Hugging Face's CDN the first
// time and are cached by the browser after that. Needs WebGPU.
import { CreateMLCEngine, type MLCEngine } from '@mlc-ai/web-llm';
import type { ToWorker, FromWorker } from './protocol';

let engine: MLCEngine | null = null;
let aborted = false;
const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      engine = await CreateMLCEngine(msg.modelId, {
        initProgressCallback: (r) => post({ type: 'progress', progress: r.progress, text: r.text }),
      });
      post({ type: 'ready', modelId: msg.modelId });
    } else if (msg.type === 'generate') {
      if (!engine) throw new Error('No model loaded');
      aborted = false;
      const started = Date.now();
      let tokens = 0;
      const stream = await engine.chat.completions.create({
        messages: msg.messages,
        stream: true,
        temperature: 0.2,
        top_p: 0.9,
        max_tokens: msg.maxTokens,
        stream_options: { include_usage: true },
      });
      for await (const chunk of stream) {
        if (aborted) { await engine.interruptGenerate(); break; }
        const text = chunk.choices[0]?.delta?.content ?? '';
        if (text) { tokens++; post({ type: 'token', id: msg.id, text }); }
        if (chunk.usage) tokens = chunk.usage.completion_tokens ?? tokens;
      }
      post({ type: 'done', id: msg.id, tokens, ms: Date.now() - started });
    } else if (msg.type === 'abort') {
      aborted = true;
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err), id: (msg as { id?: number }).id });
  }
};
