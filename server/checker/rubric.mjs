// server/checker/rubric.mjs — the rubric: checked, resolved and loaded.
//
// content/checker-rubric.json is the source. At build time `resolveRubric`
// checks its shape and turns every citation { doc, anchor } into a link into
// the reference library, failing the build if an anchor is not a passage in
// the corpus; the result is written to dist/data/checker-rubric.json, which
// is what the server reads (the production image carries dist/, not content/).
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const STATUSES = ['met', 'partly', 'missing', 'not-assessable'];
const ASSESS = new Set(['model', 'rule', 'derived', 'officer']);
const MODES = new Set(['items', 'per-allocation', 'per-policy']);

/** Every problem with the rubric's shape, as sentences. Empty when it is sound. */
export function rubricProblems(rubric) {
  const problems = [];
  const ids = new Set();
  if (JSON.stringify((rubric.statuses ?? []).map((s) => s.id)) !== JSON.stringify(STATUSES)) problems.push(`statuses must be exactly ${STATUSES.join(', ')} in that order`);
  for (const section of rubric.sections ?? []) {
    if (!section.id || !section.title || !section.letter) problems.push(`a section is missing its id, title or letter`);
    if (!MODES.has(section.mode)) problems.push(`${section.id}: unknown mode ${section.mode}`);
    for (const item of section.items ?? []) {
      if (ids.has(item.id)) problems.push(`${item.id}: duplicate id`);
      ids.add(item.id);
      if (!ASSESS.has(item.assess)) problems.push(`${item.id}: unknown assess ${item.assess}`);
      if (!item.title || !item.requirement) problems.push(`${item.id}: needs a title and a requirement`);
      if (!item.cites?.length) problems.push(`${item.id}: cites nothing`);
      if (!rubric.sources?.[item.source]) problems.push(`${item.id}: unknown source ${item.source}`);
      if (section.enabled && item.assess === 'model' && !(item.judge?.met && item.judge?.missing) && !item.conditions?.length) problems.push(`${item.id}: a model item needs judge.met and judge.missing, or conditions`);
      if (item.conditions && !(Array.isArray(item.conditions) && item.conditions.length >= 2 && item.conditions.every((c) => typeof c === 'string' && c))) problems.push(`${item.id}: conditions must be two or more statements`);
      if (item.assess === 'officer' && !item.officerAction) problems.push(`${item.id}: an officer item needs officerAction`);
    }
  }
  for (const section of rubric.sections ?? []) for (const item of section.items ?? []) {
    for (const from of item.derive?.from ?? []) if (!ids.has(from)) problems.push(`${item.id}: derives from unknown item ${from}`);
  }
  return problems;
}

/**
 * Check the rubric and resolve its citations against the corpus
 * ({ chunks: [{ doc, anchor, route }], sources: [{ id, title, short }] }).
 * Throws listing every unknown citation, so a typo fails the build.
 */
export function resolveRubric(rubric, corpus) {
  const problems = rubricProblems(rubric);
  const routes = new Map();
  for (const c of corpus.chunks) if (!routes.has(`${c.doc}#${c.anchor}`)) routes.set(`${c.doc}#${c.anchor}`, c.route);
  const sourceOf = new Map(corpus.sources.map((s) => [s.id, s]));
  const resolve = (where) => (c) => {
    const route = routes.get(`${c.doc}#${c.anchor}`);
    if (!route) { problems.push(`${where}: no corpus passage ${c.doc}#${c.anchor}`); return { ...c, href: null }; }
    return { doc: c.doc, anchor: c.anchor, label: c.label ?? c.anchor, href: `${route}#${c.anchor}`, sourceTitle: sourceOf.get(c.doc)?.short ?? c.doc };
  };
  const sections = (rubric.sections ?? []).map((s) => ({
    ...s,
    items: (s.items ?? []).map((i) => ({ ...i, cites: (i.cites ?? []).map(resolve(i.id)) })),
  }));
  const dm = rubric.nationalDecisionMakingPolicies ?? [];
  const nationalDecisionMakingPolicies = dm.map((p) => {
    const route = routes.get(`nppf#${p.code}`);
    if (!route) problems.push(`national policy ${p.code}: no corpus passage nppf#${p.code}`);
    return { ...p, href: route ? `${route}#${p.code}` : null };
  });
  if (problems.length) throw new Error(`The checker rubric has problems:\n  ${problems.join('\n  ')}`);
  return { ...rubric, $comment: undefined, sections, nationalDecisionMakingPolicies };
}

const cache = new Map();
/** Read a JSON file from dist/data once, re-reading it when the build replaces it. */
async function cachedJson(path) {
  const { mtimeMs } = await stat(path);
  const hit = cache.get(path);
  if (hit?.mtimeMs === mtimeMs) return hit.value;
  const value = JSON.parse(await readFile(path, 'utf8'));
  cache.set(path, { mtimeMs, value });
  return value;
}

/** The resolved rubric the build wrote. */
export const loadRubric = (distDir) => cachedJson(join(distDir, 'data/checker-rubric.json'));
/** The corpus the build wrote (the national policy texts come from here). */
export const loadCorpusFile = (distDir) => cachedJson(join(distDir, 'data/corpus.json'));

/** Items of the enabled sections, in rubric order. */
export function enabledSections(rubric) {
  return rubric.sections.filter((s) => s.enabled !== false);
}
