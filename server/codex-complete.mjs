// server/codex-complete.mjs — a `complete` function on the local Codex bridge.
//
// The plan checker takes any function with this contract and never learns
// which provider is behind it:
//
//   (req: { system, user, maxTokens?, temperature?, json?, signal? }) => Promise<string>
//
// This one calls an OpenAI-compatible chat completions endpoint (the Codex
// bridge on 127.0.0.1:5207 by default) without streaming. The bridge does not
// honour response_format reliably, so `json` is not passed on: the prompts ask
// for JSON and the checker parses defensively. One retry after a pause rides
// out the bridge restarting, as the Ask endpoint does. It is the stand-in
// until server/llm.mjs supplies the provider-neutral version, and the dev
// script scripts/check-plan.mjs uses it too.

const pause = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

export function codexComplete({ bridgeUrl = 'http://127.0.0.1:5207', model = 'gpt-6-luna', retryDelayMs = 4000, fetchImpl = fetch } = {}) {
  const url = `${bridgeUrl.replace(/\/$/, '')}/v1/chat/completions`;
  return async ({ system, user, maxTokens = 2000, temperature = 0, signal }) => {
    const body = JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature, max_tokens: maxTokens, stream: false,
    });
    const call = () => fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer codex-bridge-local' }, body, signal });
    let res = await call().catch((err) => { if (signal?.aborted) throw err; return null; });
    if (!res?.ok) {
      res?.body?.cancel().catch(() => {});
      await pause(retryDelayMs, signal);
      res = await call();
    }
    if (!res.ok) throw new Error(`the model endpoint answered ${res.status}`);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('the model endpoint returned no content');
    return content;
  };
}
