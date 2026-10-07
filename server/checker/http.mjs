// server/checker/http.mjs — the plan checker's two endpoints.
//
//   POST /api/projects/local-plan-navigator/check
//     The plan as multipart/form-data (field "plan"), or as the raw body with
//     its name in an X-File-Name header. Answers 4xx with { message } if the
//     file cannot be checked, otherwise a stream of server-sent events:
//     "progress" { step, total, message } as each part is checked, then one
//     "report" { report } or one "error" { message }.
//
//   POST /api/projects/local-plan-navigator/check/export
//     { report, format: "docx" | "md", part: "statements" | "report" }: the
//     draft statements as Word, or the statements or the whole report as
//     Markdown. The report is validated against the schema first.
//
// The uploaded file is held in memory for the length of the request and is
// never written to disk or logged. Checks are limited per signed-in user (a
// few an hour, one at a time), across the server (two at once) and per day,
// because each one makes a dozen or more model calls.
//
// The handlers take (req, res, ctx), where ctx is { user, siteOrigin } from
// the app: who the gateway says is asking, and the origin pages come from.
import { runCheck } from './pipeline.mjs';
import { DOCUMENT_LIMITS, DocumentError, readDocument, sizeLabel } from './read-document.mjs';
import { loadCorpusFile, loadRubric } from './rubric.mjs';
import { fileSlug, reportMarkdown, statementsDocx, statementsMarkdown } from './export.mjs';
import { reportProblems } from './schema.mjs';

export const CHECK_PATH = '/api/projects/local-plan-navigator/check';
export const EXPORT_PATH = '/api/projects/local-plan-navigator/check/export';
export const CHECKER_PATHS = [CHECK_PATH, EXPORT_PATH];

export const HTTP_LIMITS = {
  checksPerHour: 6,          // per user
  checksPerDay: 60,          // across the server
  concurrentChecks: 2,       // across the server
  checkTimeoutMs: 8 * 60_000,
  heartbeatMs: 15_000,       // keeps proxies from closing a quiet stream
  exportBodyBytes: 4 * 1024 * 1024,
  exportsPerMinute: 30,      // per user
};

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

/** Read a request body up to `max` bytes; past that, drain it and answer 413. */
async function readBody(req, max, tooLarge) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) throw new HttpError(413, tooLarge);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max * 4) { req.destroy(); throw new HttpError(413, tooLarge); }
    if (size <= max) chunks.push(chunk);
  }
  if (size > max) throw new HttpError(413, tooLarge);
  return Buffer.concat(chunks);
}

/** The value of a header parameter, honouring RFC 5987 filename*=UTF-8''... */
function headerParam(header, name) {
  const star = header.match(new RegExp(`${name}\\*\\s*=\\s*([^']*)'[^']*'([^;]+)`, 'i'));
  if (star) { try { return decodeURIComponent(star[2].trim()); } catch { /* fall through */ } }
  const plain = header.match(new RegExp(`${name}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;]+))`, 'i'));
  return plain ? (plain[1] ?? plain[2]).replace(/\\(.)/g, '$1').trim() : null;
}

/**
 * The file in a multipart/form-data body: the part named "plan", or failing
 * that the first part with a filename. Returns { name, bytes }.
 */
export function parseMultipart(body, contentType) {
  const boundaryValue = headerParam(contentType, 'boundary');
  if (!boundaryValue || boundaryValue.length > 200) throw new HttpError(400, 'The upload could not be read. Try again');
  const boundary = Buffer.from(`--${boundaryValue}`);
  const delimiter = Buffer.from(`\r\n--${boundaryValue}`);
  let pos = body.indexOf(boundary);
  const parts = [];
  while (pos >= 0 && parts.length < 20) {
    pos += boundary.length;
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break; // the closing boundary
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    const headerEnd = body.indexOf('\r\n\r\n', pos);
    if (headerEnd < 0) break;
    const headers = body.subarray(pos, headerEnd).toString('utf8');
    const end = body.indexOf(delimiter, headerEnd + 4);
    if (end < 0) break;
    parts.push({ headers, data: body.subarray(headerEnd + 4, end) });
    pos = end + 2;
  }
  const described = parts.map((p) => {
    const disposition = p.headers.split('\r\n').find((l) => /^content-disposition:/i.test(l)) ?? '';
    return { field: headerParam(disposition, 'name'), filename: headerParam(disposition, 'filename'), data: p.data };
  });
  const file = described.find((p) => p.field === 'plan' && p.filename != null) ?? described.find((p) => p.filename != null);
  if (!file || !file.filename) throw new HttpError(400, 'Select a draft local plan to check');
  return { name: file.filename, bytes: file.data };
}

/** A token bucket per key: `capacity` uses, refilled evenly over `periodMs`. */
function limiter(capacity, periodMs, now) {
  const buckets = new Map();
  return (key) => {
    const t = now();
    const b = buckets.get(key) ?? { tokens: capacity, at: t };
    b.tokens = Math.min(capacity, b.tokens + (t - b.at) * (capacity / periodMs));
    b.at = t;
    buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

const crossOrigin = (req, ctx) => Boolean(ctx.siteOrigin && req.headers.origin && req.headers.origin !== ctx.siteOrigin);

/**
 * The check endpoint. `complete` is the model, with the contract in
 * pipeline.mjs; `distDir` holds the built rubric and corpus.
 */
export function createCheckHandler({ complete, distDir, limits = {}, documentLimits = {}, checkLimits = {}, now = () => Date.now() }) {
  if (typeof complete !== 'function') throw new TypeError('createCheckHandler needs a complete function');
  const lim = { ...HTTP_LIMITS, ...limits };
  const docLim = { ...DOCUMENT_LIMITS, ...documentLimits };
  const allow = limiter(lim.checksPerHour, 60 * 60_000, now);
  const running = new Set();
  let day = '';
  let usedToday = 0;

  return async (req, res, ctx = {}) => {
    const user = ctx.user ?? 'anonymous';
    if (req.method !== 'POST') { sendJson(res, 405, { message: 'Method not allowed.' }); return; }
    if (crossOrigin(req, ctx)) { sendJson(res, 403, { message: 'Plans are only taken from pages this server sent.' }); return; }
    if (running.has(user)) { sendJson(res, 409, { message: 'A check is already running for you. Wait for it to finish.' }); return; }
    if (running.size >= lim.concurrentChecks) { sendJson(res, 503, { message: 'The checker is busy. Try again in a few minutes.' }); return; }
    const today = new Date(now()).toISOString().slice(0, 10);
    if (today !== day) { day = today; usedToday = 0; }
    if (usedToday >= lim.checksPerDay) { sendJson(res, 503, { message: "Today's allowance of plan checks has been used. Try again tomorrow." }); return; }

    // Claimed before the body is read, so two uploads at once cannot both start.
    running.add(user);
    let streaming = false;
    try {
      const body = await readBody(req, docLim.maxBytes + 64 * 1024, `The selected file must be smaller than ${sizeLabel(docLim.maxBytes)}`);
      const type = String(req.headers['content-type'] ?? '');
      let upload;
      if (/^multipart\/form-data/i.test(type)) upload = parseMultipart(body, type);
      else {
        let name = String(req.headers['x-file-name'] ?? '');
        try { name = decodeURIComponent(name); } catch { /* keep it as sent */ }
        if (!name) throw new HttpError(400, 'Select a draft local plan to check');
        upload = { name, bytes: body };
      }
      const document = readDocument({ ...upload, limits: docLim });
      if (!allow(user)) throw new HttpError(429, 'You have checked several plans in the last hour. Wait a while and try again.');
      let rubric;
      let corpus;
      try { [rubric, corpus] = await Promise.all([loadRubric(distDir), loadCorpusFile(distDir)]); }
      catch { throw new HttpError(503, 'The checker is not available just now. Try again later.'); }
      usedToday++;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'private, no-store',
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff',
      });
      streaming = true;
      const send = (type, data) => { if (!res.destroyed) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`); };
      const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': still checking\n\n'); }, lim.heartbeatMs);
      const gone = new AbortController();
      res.on('close', () => gone.abort());
      const timeout = AbortSignal.timeout(lim.checkTimeoutMs);
      try {
        const report = await runCheck({
          document, rubric, corpus, complete, limits: checkLimits,
          signal: AbortSignal.any([gone.signal, timeout]),
          onProgress: (p) => send('progress', p),
        });
        send('report', { report });
      } catch {
        send('error', { message: timeout.aborted ? 'The check took too long and was stopped. Try again, or check a shorter document.' : 'The check could not be completed. Try again in a few minutes.' });
      } finally {
        clearInterval(heartbeat);
        res.end();
      }
    } catch (err) {
      if (streaming) return;
      const status = err instanceof HttpError || err instanceof DocumentError ? err.status : 400;
      const message = err instanceof HttpError || err instanceof DocumentError ? err.message : 'The selected file could not be read. Check it opens, save it again and try again';
      if (!res.headersSent) sendJson(res, status, { message, field: 'plan-file' });
      else res.end();
    } finally {
      running.delete(user);
    }
  };
}

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** The export endpoint: a report in, a file out. No model is involved. */
export function createExportHandler({ limits = {}, siteUrl, now = () => Date.now() } = {}) {
  const lim = { ...HTTP_LIMITS, ...limits };
  const allow = limiter(lim.exportsPerMinute, 60_000, now);
  return async (req, res, ctx = {}) => {
    if (req.method !== 'POST') { sendJson(res, 405, { message: 'Method not allowed.' }); return; }
    if (crossOrigin(req, ctx)) { sendJson(res, 403, { message: 'Reports are only taken from pages this server sent.' }); return; }
    if (!allow(ctx.user ?? 'anonymous')) { sendJson(res, 429, { message: 'Too many downloads in a short time. Wait a minute and try again.' }); return; }
    let input;
    try { input = JSON.parse((await readBody(req, lim.exportBodyBytes, 'The report is too large to export.')).toString('utf8')); }
    catch (err) { sendJson(res, err instanceof HttpError ? err.status : 400, { message: err instanceof HttpError ? err.message : 'The report could not be read. Run the check again.' }); return; }
    const format = input?.format === 'md' ? 'md' : input?.format === 'docx' ? 'docx' : null;
    const part = input?.part === 'report' ? 'report' : 'statements';
    if (!format) { sendJson(res, 400, { message: 'Choose Word or Markdown.' }); return; }
    const problems = reportProblems(input.report);
    if (problems.length) { sendJson(res, 400, { message: 'The report could not be read. Run the check again.', problems: problems.slice(0, 5) }); return; }
    const report = input.report;
    const slug = fileSlug(report.document.name);
    let body;
    let type;
    let name;
    try {
      if (format === 'docx') { body = statementsDocx(report); type = DOCX_TYPE; name = `draft-gateway-statements-${slug}.docx`; }
      else if (part === 'report') { body = Buffer.from(reportMarkdown(report, siteUrl ? { siteUrl } : {})); type = 'text/markdown; charset=utf-8'; name = `plan-check-${slug}.md`; }
      else { body = Buffer.from(statementsMarkdown(report)); type = 'text/markdown; charset=utf-8'; name = `draft-gateway-statements-${slug}.md`; }
    } catch {
      sendJson(res, 400, { message: 'The report could not be exported. Run the check again.' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body.length,
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  };
}

/** Both endpoints behind one function, for the app to mount in one line. */
export function createCheckerRoutes(options) {
  const check = createCheckHandler(options);
  const exportReport = createExportHandler(options);
  return (req, res, ctx) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    return (pathname === EXPORT_PATH ? exportReport : check)(req, res, ctx);
  };
}
