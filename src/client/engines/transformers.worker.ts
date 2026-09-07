// src/client/engines/transformers.worker.ts — a transformers.js engine behind the protocol.
//
// The fallback for browsers without WebGPU: ONNX Runtime running on
// WebAssembly. Slow — a few tokens a second on a laptop — but it works
// everywhere, and it is the path the smoke tests can exercise. The ONNX
// runtime's .wasm files are served next to this script, under ./ort/.
import { pipeline, TextStreamer, env, type TextGenerationPipeline } from '@huggingface/transformers';
import type { ToWorker, FromWorker } from './protocol';

env.allowLocalModels = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(env.backends.onnx as any).wasm.wasmPaths = new URL('./ort/', self.location.href).href;

let generator: TextGenerationPipeline | null = null;
let aborted = false;
const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      const files = new Map<string, { loaded: number; total: number }>();
      generator = (await pipeline('text-generation', msg.modelId, {
        dtype: 'q4',
        device: 'wasm',
        progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
          if (p.status === 'progress' && p.file) files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
          const loaded = [...files.values()].reduce((a, f) => a + f.loaded, 0);
          const total = [...files.values()].reduce((a, f) => a + f.total, 0);
          post({ type: 'progress', progress: total ? loaded / total : 0, text: p.status === 'ready' ? 'Loaded' : `${p.status} ${p.file ?? ''}`.trim() });
        },
      })) as TextGenerationPipeline;
      post({ type: 'ready', modelId: msg.modelId });
    } else if (msg.type === 'generate') {
      if (!generator) throw new Error('No model loaded');
      aborted = false;
      const started = Date.now();
      let tokens = 0;
      const streamer = new TextStreamer(generator.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (text: string) => { tokens++; if (!aborted) post({ type: 'token', id: msg.id, text }); },
      });
      await generator(msg.messages, { max_new_tokens: msg.maxTokens, do_sample: false, repetition_penalty: 1.1, streamer });
      post({ type: 'done', id: msg.id, tokens, ms: Date.now() - started });
    } else if (msg.type === 'abort') {
      aborted = true;
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err), id: (msg as { id?: number }).id });
  }
};
