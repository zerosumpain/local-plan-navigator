// src/client/engines/protocol.ts — the messages between the page and a model worker.
//
// Both engines (WebLLM on WebGPU, transformers.js on WebAssembly) speak this
// one protocol, so the Ask page does not care which is running.
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export type ToWorker =
  | { type: 'load'; modelId: string }
  | { type: 'generate'; id: number; messages: ChatMessage[]; maxTokens: number }
  | { type: 'abort' };

export type FromWorker =
  | { type: 'progress'; progress: number; text: string }
  | { type: 'ready'; modelId: string }
  | { type: 'token'; id: number; text: string }
  | { type: 'done'; id: number; tokens: number; ms: number }
  | { type: 'error'; message: string; id?: number };
