// scripts/site-map.mjs — every page the build renders, in one place.
//
// A page is { id, route, template, title, ...data }. The id is what the client
// script keys on (data-page on <body>); the route is the URL; the template is a
// file in src/pages/. Pages generated from content data (stages, gateways,
// checklists, questions, results, reference texts) are pushed in loops below.
//
// `ref(r)` resolves a content reference { doc, anchor, label } to a link using
// the anchors the corpus builder produced, so a typo in the data fails the
// build here rather than becoming a dead link.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { timelineSvg, flowSvg, mermaidText } from './lib/diagrams.mjs';
import { exampleSchedule } from '../src/lib/schedule.ts';
import { ganttSvg } from '../src/lib/gantt.ts';

/** doc#anchor -> route for every reference the schedule can cite (they are fixed in code). */
function plannerRefRoutes(schedule, anchors) {
  const out = {};
  for (const x of [...schedule.milestones, ...schedule.checks]) if (x.ref) out[`${x.ref.doc}#${x.ref.anchor}`] = anchors[x.ref.doc]?.[x.ref.anchor] ?? null;
  return out;
}

export async function siteMap({ root, corpus, code }) {
  const content = async (name) => JSON.parse(await readFile(path.join(root, 'content', name), 'utf8'));
  const [stagesData, navigator, checklistsData, glossary, flowsData, sourcesData] = await Promise.all([
    content('stages.json'), content('navigator.json'), content('checklists.json'), content('glossary.json'), content('flows.json'), content('sources.json'),
  ]);
  const { phases, stages } = stagesData;
  const flows = flowsData.flows;
  const sourceById = Object.fromEntries(corpus.sources.map((s) => [s.id, s]));

  const missing = [];
  const ref = (r) => {
    if (!r) return null;
    const anchors = corpus.anchors[r.doc];
    const src = sourceById[r.doc];
    if (!anchors || !src) { missing.push(`${r.doc} (unknown source)`); return { ...r, href: '#', title: r.label ?? r.doc }; }
    if (!r.anchor) return { ...r, href: src.route, title: r.label ?? src.title, sourceTitle: src.title };
    const route = anchors[r.anchor];
    if (!route) { missing.push(`${r.doc}#${r.anchor}`); return { ...r, href: src.route, title: r.label ?? r.anchor, sourceTitle: src.title, broken: true }; }
    return { ...r, href: `${route}#${r.anchor}`, title: r.label ?? r.anchor, sourceTitle: src.title };
  };
  const resolveStage = (s) => ({
    ...s,
    phaseInfo: phases.find((p) => p.id === s.phase),
    refs: (s.refs ?? []).map(ref),
    guidance: (s.guidance ?? []).map(ref),
    timings: (s.timings ?? []).map((t) => ({ ...t, ref: ref(t.ref) })),
    nextStages: (s.next ?? []).map((id) => stages.find((x) => x.id === id)).filter(Boolean),
    prevStages: stages.filter((x) => (x.next ?? []).includes(s.id)),
    diagramSvg: s.diagram && flows[s.diagram] ? flowSvg(flows[s.diagram], { id: `flow-${s.diagram}` }) : null,
    diagramMermaid: s.diagram && flows[s.diagram] ? mermaidText(flows[s.diagram]) : null,
    diagramFlow: s.diagram ? flows[s.diagram] : null,
  });
  const resolvedStages = stages.map(resolveStage);
  const gateways = resolvedStages.filter((s) => s.kind === 'gateway');

  const pages = [
    { id: 'home', route: '/', template: 'index', title: 'Find your way through the local plan process' },
    {
      id: 'process', route: '/process/', template: 'process', title: 'The 30-month local plan process',
      phases, stages: resolvedStages, timelineSvg: timelineSvg(stagesData, { id: 'timeline' }),
      sequenceSvg: flowSvg(flows.sequence, { id: 'flow-sequence' }), sequenceMermaid: mermaidText(flows.sequence), sequenceFlow: flows.sequence,
    },
    { id: 'gateways', route: '/gateways/', template: 'gateways', title: 'The three gateways', gateways, stages: resolvedStages },
    { id: 'checklists', route: '/checklists/', template: 'checklists', title: 'Checklists', checklists: checklistsData.checklists },
    { id: 'glossary', route: '/glossary/', template: 'glossary', title: 'Glossary', terms: glossary.terms.map((t) => ({ ...t, ref: ref(t.ref) })), abbreviations: glossary.abbreviations },
    { id: 'planner', route: '/planner/', template: 'planner', title: 'Timeline planner', example: exampleSchedule(), ganttSvg: ganttSvg(exampleSchedule(), { id: 'gantt-example' }), corpusAnchors: corpus.anchors, isExample: true, refRoutes: plannerRefRoutes(exampleSchedule(), corpus.anchors) },
    { id: 'search', route: '/search/', template: 'search', title: 'Search the guidance', sources: corpus.sources, corpusMeta: corpus.meta },
    { id: 'ask', route: '/ask/', template: 'ask', title: 'Describe a problem', sources: corpus.sources, corpusMeta: corpus.meta },
    { id: 'where-am-i', route: '/where-am-i/', template: 'where-am-i', title: 'Where is my plan?', navigator },
    { id: 'environmental-assessment', route: '/environmental-assessment/', template: 'environmental-assessment', title: 'Strategic Environmental Assessment and the environmental report', ref },
    { id: 'national-policy', route: '/national-policy/', template: 'national-policy', title: 'What the National Planning Policy Framework asks of a local plan', ref, nppfChapters: corpus.pages.filter((p) => p.template === 'reference-index' && p.source.id === 'nppf')[0]?.units ?? [] },
    { id: 'examination', route: '/examination/', template: 'examination', title: 'The examination', stage: resolvedStages.find((s) => s.id === 'examination'), submission: resolvedStages.find((s) => s.id === 'submission'), report: resolvedStages.find((s) => s.id === 'report'), ref },
    { id: 'about', route: '/about/', template: 'about', title: 'About this prototype' },
    { id: 'accessibility', route: '/accessibility/', template: 'accessibility', title: 'Accessibility statement' },
    { id: 'sources', route: '/sources/', template: 'sources', title: 'Sources, dates and licences', sources: corpus.sources, corpusMeta: corpus.meta },
    { id: 'code', route: '/code/', template: 'code', title: 'The code', code },
    { id: 'reference-home', route: '/reference/', template: 'reference-home', title: 'Reference library', sources: corpus.sources },
  ];

  for (const s of resolvedStages) {
    pages.push({ id: 'stage', route: `/process/${s.id}/`, template: 'stage', title: s.title, stage: s, phases, breadcrumbs: [{ text: 'Home', href: '../../' }, { text: 'Process', href: '../' }, { text: s.short }] });
  }
  for (const c of checklistsData.checklists) {
    pages.push({ id: 'checklist', route: `/checklists/${c.id}/`, template: 'checklist', title: c.title, checklist: { ...c, ref: ref(c.ref), guidance: ref(c.guidance) }, breadcrumbs: [{ text: 'Home', href: '../../' }, { text: 'Checklists', href: '../' }, { text: c.title }] });
  }
  for (const [qid, q] of Object.entries(navigator.questions)) {
    pages.push({ id: 'question', route: `/where-am-i/${qid}/`, template: 'question', title: q.title, question: { id: qid, ...q }, navigator, backLink: { href: '../', text: 'Back' } });
  }
  for (const [rid, r] of Object.entries(navigator.results)) {
    const stageOf = (id) => resolvedStages.find((s) => s.id === id);
    pages.push({
      id: 'result', route: `/where-am-i/result/${rid}/`, template: 'result', title: r.title,
      result: { id: rid, ...r, now: (r.now ?? []).map((t) => ({ ...t, stageInfo: t.stage ? stageOf(t.stage) : null })), refs: (r.refs ?? []).map(ref), nextGatewayInfo: r.nextGateway ? { stage: stageOf(r.nextGateway.stage), checklist: checklistsData.checklists.find((c) => c.id === r.nextGateway.checklist) } : null, checklistInfo: r.checklist ? checklistsData.checklists.find((c) => c.id === r.checklist) : null },
      backLink: { href: '../../', text: 'Start again' },
    });
  }
  for (const p of corpus.pages) pages.push(p);

  if (missing.length) throw new Error(`Unresolved references in content data:\n  ${[...new Set(missing)].join('\n  ')}`);

  const nav = [
    { text: 'Process', href: 'process/' },
    { text: 'Gateways', href: 'gateways/' },
    { text: 'Where am I?', href: 'where-am-i/' },
    { text: 'Planner', href: 'planner/' },
    { text: 'Checklists', href: 'checklists/' },
    { text: 'Search', href: 'search/' },
    { text: 'Ask', href: 'ask/' },
    { text: 'Code', href: 'code/' },
  ];
  return { pages, nav, stages: resolvedStages, phases, corpus, code, sources: corpus.sources };
}
