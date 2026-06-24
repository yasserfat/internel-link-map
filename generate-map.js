/**
 * Générateur de carte du maillage interne — DevFlows
 * ─────────────────────────────────────────────────────────────────
 * Lit maillage-interne.csv (produit par crawler-maillage-devflows.js)
 * et génère maillage-map.html : une carte interactive (graphe D3.js)
 * du maillage interne du site.
 *
 * Lance avec : node generate-map.js
 * ─────────────────────────────────────────────────────────────────
 */

import { readFileSync, writeFileSync } from 'fs';

const INPUT_CSV  = 'maillage-interne.csv';
const OUTPUT_HTML = 'maillage-map.html';

// Pages piliers et de service — doit correspondre au crawler
const PILIERS = {
  '/agence-n8n'            : 'PILIER n8n',
  '/automatisation-ia'     : 'PILIER automation IA',
  '/agence-ia'             : 'SERVICE agence IA',
  '/audit-ia'              : 'SERVICE audit IA',
  '/integration-ia'        : 'SERVICE intégration IA',
  '/creation-agent-ia'     : 'SERVICE agents IA',
  '/audit-ia-pour-expert-comptable' : 'SERVICE expert-comptable',
};

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function categoryOf(path) {
  if (path === '/') return 'accueil';
  if (PILIERS[path]) return 'pilier';
  if (path.startsWith('/post/')) return 'post';
  if (path.startsWith('/use-case/')) return 'usecase';
  return 'autre';
}

console.log('Lecture de', INPUT_CSV, '...');
let csv = readFileSync(INPUT_CSV, 'utf8');
if (csv.charCodeAt(0) === 0xFEFF) csv = csv.slice(1);

const rows = parseCSV(csv);
const data = rows.slice(1).filter(r => r.length >= 6 && r[0] !== '');

// ── Construire les pages et les arêtes agrégées ──
const allPaths = new Set();
const sourcesOfDest = new Map();   // dst -> Set(sources)
const edgeMap = new Map();         // "src|||dst" -> { source, destination, weight, anchors:Set }

data.forEach(r => {
  const [src, dst, anchor, type] = r;
  allPaths.add(src);
  allPaths.add(dst);
  if (type === 'redirect') return;
  if (src === dst) return;

  if (!sourcesOfDest.has(dst)) sourcesOfDest.set(dst, new Set());
  sourcesOfDest.get(dst).add(src);

  const key = src + '|||' + dst;
  if (!edgeMap.has(key)) edgeMap.set(key, { source: src, target: dst, weight: 0, anchors: new Set() });
  const e = edgeMap.get(key);
  e.weight++;
  if (anchor && anchor !== '[vide]' && e.anchors.size < 6) e.anchors.add(anchor);
});

const totalSourcePages = allPaths.size;

const nodes = [...allPaths].map(path => {
  const inboundDistinct = sourcesOfDest.get(path)?.size || 0;
  return {
    id: path,
    category: categoryOf(path),
    label: PILIERS[path] || path,
    inboundDistinct,
    isOrphan: inboundDistinct === 0 && path !== '/',
    isTypo: /servieces/.test(path),
  };
});

const edges = [...edgeMap.values()].map(e => ({
  source: e.source,
  target: e.target,
  weight: e.weight,
  distinctSourcesOfTarget: sourcesOfDest.get(e.target)?.size || 0,
  anchors: [...e.anchors],
}));

console.log(`Pages : ${nodes.length} | Liens agrégés : ${edges.length} | Pages sources totales : ${totalSourcePages}`);

const payload = { nodes, edges, totalSourcePages, generatedAt: new Date().toISOString() };

// ── Générer le HTML ──
const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Carte du maillage interne — DevFlows</title>
<script src="https://d3js.org/d3.v7.min.js"></script>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, Segoe UI, Roboto, sans-serif; background: #0b0e14; color: #e6e6e6; }
  #app { display: flex; height: 100vh; }
  #sidebar { width: 320px; flex-shrink: 0; padding: 16px; background: #11151c; border-right: 1px solid #232936; overflow-y: auto; }
  #graph-wrap { flex: 1; position: relative; }
  svg { width: 100%; height: 100%; display: block; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  .sub { font-size: 12px; color: #8b93a3; margin-bottom: 16px; }
  .stat-row { display: flex; justify-content: space-between; font-size: 12px; padding: 3px 0; border-bottom: 1px dashed #232936; }
  .stat-row b { color: #fff; }
  fieldset { border: 1px solid #232936; border-radius: 6px; margin: 14px 0; padding: 10px; }
  legend { font-size: 11px; color: #8b93a3; padding: 0 4px; }
  label { display: flex; align-items: center; gap: 6px; font-size: 12px; margin: 6px 0; cursor: pointer; }
  input[type=range] { width: 100%; }
  input[type=text] { width: 100%; padding: 6px 8px; border-radius: 4px; border: 1px solid #232936; background: #0b0e14; color: #fff; font-size: 12px; }
  .legend-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  #threshold-val { color: #fff; font-weight: 600; }
  #details { margin-top: 14px; font-size: 12px; }
  #details h3 { font-size: 13px; margin: 0 0 6px; word-break: break-all; }
  #details .grp { margin-top: 8px; }
  #details .grp-title { color: #8b93a3; margin-bottom: 4px; }
  #details ul { margin: 0; padding-left: 16px; max-height: 160px; overflow-y: auto; }
  #details li { margin-bottom: 2px; word-break: break-all; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 10px; font-size: 10px; margin-left: 4px; }
  .badge-orphan { background: #7f1d1d; color: #fecaca; }
  .badge-typo { background: #78350f; color: #fde68a; }
  .node-label { font-size: 9px; fill: #c7ccd6; pointer-events: none; }
  .link { stroke: #3a4250; stroke-opacity: 0.45; }
  .link.highlight { stroke: #f59e0b; stroke-opacity: 0.9; }
  .node { cursor: pointer; stroke: #0b0e14; stroke-width: 1px; }
  .node.dim { opacity: 0.12; }
  #tooltip { position: absolute; pointer-events: none; background: #1a202c; border: 1px solid #2d3748; border-radius: 6px; padding: 6px 10px; font-size: 11px; max-width: 320px; display: none; z-index: 10; }
  #empty-msg { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); color: #555; font-size: 13px; display:none; }
</style>
</head>
<body>
<div id="app">
  <div id="sidebar">
    <h1>Maillage interne — DevFlows</h1>
    <div class="sub">devflows.eu &middot; généré le ${new Date().toLocaleDateString('fr-FR')}</div>

    <div class="stat-row"><span>Pages crawlées</span><b id="stat-pages"></b></div>
    <div class="stat-row"><span>Liens uniques (src→dst)</span><b id="stat-edges"></b></div>
    <div class="stat-row"><span>Liens affichés (filtrés)</span><b id="stat-edges-visible"></b></div>
    <div class="stat-row"><span>Pages isolées (≤1 source)</span><b id="stat-isolated"></b></div>

    <fieldset>
      <legend>Filtrer le bruit du menu global</legend>
      <label>Seuil maillage global : pages liées par <span id="threshold-val">100</span>+ sources sont masquées</label>
      <input type="range" id="threshold" min="2" max="${totalSourcePages}" value="100">
      <div class="sub" style="margin:6px 0 0">Baissez le curseur pour ne garder que les liens contextuels (articles de blog, études de cas) et révéler les pages mal maillées.</div>
    </fieldset>

    <fieldset>
      <legend>Filtrer par catégorie</legend>
      <label><input type="checkbox" class="cat-filter" value="accueil" checked> <span class="legend-dot" style="background:#fbbf24"></span> Accueil</label>
      <label><input type="checkbox" class="cat-filter" value="pilier" checked> <span class="legend-dot" style="background:#ef4444"></span> Pages piliers / services</label>
      <label><input type="checkbox" class="cat-filter" value="post" checked> <span class="legend-dot" style="background:#10b981"></span> Articles de blog</label>
      <label><input type="checkbox" class="cat-filter" value="usecase" checked> <span class="legend-dot" style="background:#8b5cf6"></span> Études de cas</label>
      <label><input type="checkbox" class="cat-filter" value="autre" checked> <span class="legend-dot" style="background:#60a5fa"></span> Autres pages</label>
    </fieldset>

    <fieldset>
      <legend>Recherche</legend>
      <input type="text" id="search" placeholder="ex: /post/n8n-vs-make">
    </fieldset>

    <div id="details"><div class="sub">Cliquez sur une page pour voir ses liens entrants / sortants.</div></div>
  </div>
  <div id="graph-wrap">
    <svg></svg>
    <div id="tooltip"></div>
    <div id="empty-msg">Aucun lien ne correspond aux filtres actuels.</div>
  </div>
</div>

<script>
const DATA = ${JSON.stringify(payload)};
const COLORS = { accueil: '#fbbf24', pilier: '#ef4444', post: '#10b981', usecase: '#8b5cf6', autre: '#60a5fa' };

document.getElementById('stat-pages').textContent = DATA.nodes.length;
document.getElementById('stat-edges').textContent = DATA.edges.length;

const svg = d3.select('svg');
const wrap = document.getElementById('graph-wrap');
let width = wrap.clientWidth, height = wrap.clientHeight;

const g = svg.append('g');
svg.call(d3.zoom().scaleExtent([0.1, 6]).on('zoom', (ev) => g.attr('transform', ev.transform)));

const nodeById = new Map(DATA.nodes.map(n => [n.id, n]));
const inboundIndex = new Map(); // id -> [{from, weight, anchors}]
const outboundIndex = new Map(); // id -> [{to, weight, anchors}]
DATA.edges.forEach(e => {
  if (!outboundIndex.has(e.source)) outboundIndex.set(e.source, []);
  outboundIndex.get(e.source).push(e);
  if (!inboundIndex.has(e.target)) inboundIndex.set(e.target, []);
  inboundIndex.get(e.target).push(e);
});

const radius = d3.scaleSqrt().domain([0, d3.max(DATA.nodes, d => d.inboundDistinct) || 1]).range([4, 26]);

let simulation, linkSel, nodeSel, labelSel;
let selectedId = null;

function currentFilters() {
  const threshold = +document.getElementById('threshold').value;
  const cats = new Set([...document.querySelectorAll('.cat-filter:checked')].map(c => c.value));
  return { threshold, cats };
}

function build() {
  const { threshold, cats } = currentFilters();
  document.getElementById('threshold-val').textContent = threshold;

  const visibleEdges = DATA.edges.filter(e =>
    e.distinctSourcesOfTarget < threshold &&
    cats.has(nodeById.get(e.source).category) &&
    cats.has(nodeById.get(e.target).category)
  );
  const usedIds = new Set();
  visibleEdges.forEach(e => { usedIds.add(e.source); usedIds.add(e.target); });
  const visibleNodes = DATA.nodes.filter(n => cats.has(n.category) && usedIds.has(n.id));

  document.getElementById('stat-edges-visible').textContent = visibleEdges.length;
  document.getElementById('stat-isolated').textContent =
    DATA.nodes.filter(n => n.inboundDistinct <= 1 && n.id !== '/').length;
  document.getElementById('empty-msg').style.display = visibleEdges.length ? 'none' : 'block';

  g.selectAll('*').remove();
  if (simulation) simulation.stop();

  const linkG = g.append('g').attr('class', 'links');
  const nodeG = g.append('g').attr('class', 'nodes');
  const labelG = g.append('g').attr('class', 'labels');

  const linkData = visibleEdges.map(e => ({ ...e, source: e.source, target: e.target }));

  linkSel = linkG.selectAll('line').data(linkData).join('line')
    .attr('class', 'link')
    .attr('stroke-width', d => Math.min(0.5 + Math.log2(d.weight + 1), 4));

  nodeSel = nodeG.selectAll('circle').data(visibleNodes, d => d.id).join('circle')
    .attr('class', 'node')
    .attr('r', d => radius(d.inboundDistinct))
    .attr('fill', d => COLORS[d.category])
    .on('mouseenter', (ev, d) => showTooltip(ev, d))
    .on('mousemove', (ev) => moveTooltip(ev))
    .on('mouseleave', hideTooltip)
    .on('click', (ev, d) => { ev.stopPropagation(); selectNode(d.id); });

  labelSel = labelG.selectAll('text').data(visibleNodes.filter(d => d.inboundDistinct >= radius.domain()[1] * 0.15 || d.category === 'pilier' || d.category === 'accueil'), d => d.id)
    .join('text')
    .attr('class', 'node-label')
    .text(d => d.id.length > 28 ? d.id.slice(0, 26) + '…' : d.id)
    .attr('dy', d => -radius(d.inboundDistinct) - 4)
    .attr('text-anchor', 'middle');

  simulation = d3.forceSimulation(visibleNodes)
    .force('link', d3.forceLink(linkData).id(d => d.id).distance(d => 60 + (1 / Math.max(d.weight, 1)) * 20).strength(0.15))
    .force('charge', d3.forceManyBody().strength(-90))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collide', d3.forceCollide().radius(d => radius(d.inboundDistinct) + 6))
    .on('tick', ticked);

  nodeSel.call(drag(simulation));

  if (selectedId) applyHighlight(selectedId);
}

function ticked() {
  linkSel.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
         .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
  nodeSel.attr('cx', d => d.x).attr('cy', d => d.y);
  labelSel.attr('x', d => d.x).attr('y', d => d.y);
}

function drag(sim) {
  function started(ev, d) { if (!ev.active) sim.alphaTarget(0.2).restart(); d.fx = d.x; d.fy = d.y; }
  function dragged(ev, d) { d.fx = ev.x; d.fy = ev.y; }
  function ended(ev, d) { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }
  return d3.drag().on('start', started).on('drag', dragged).on('end', ended);
}

const tooltip = document.getElementById('tooltip');
function showTooltip(ev, d) {
  const inbound = (inboundIndex.get(d.id) || []).length;
  const outbound = (outboundIndex.get(d.id) || []).length;
  tooltip.innerHTML = '<b>' + d.id + '</b><br>Sources entrantes distinctes : ' + d.inboundDistinct +
    '<br>Liens entrants (arêtes) : ' + inbound + ' &middot; Liens sortants : ' + outbound +
    (d.isOrphan ? '<br><span style="color:#fecaca">⚠ Orpheline</span>' : '') +
    (d.isTypo ? '<br><span style="color:#fde68a">⚠ URL suspecte (faute de frappe ?)</span>' : '');
  tooltip.style.display = 'block';
  moveTooltip(ev);
}
function moveTooltip(ev) {
  tooltip.style.left = (ev.clientX + 14) + 'px';
  tooltip.style.top = (ev.clientY + 10) + 'px';
}
function hideTooltip() { tooltip.style.display = 'none'; }

function selectNode(id) {
  selectedId = id;
  applyHighlight(id);
  renderDetails(id);
}

function applyHighlight(id) {
  const neighbors = new Set([id]);
  (outboundIndex.get(id) || []).forEach(e => neighbors.add(e.target));
  (inboundIndex.get(id) || []).forEach(e => neighbors.add(e.source));
  nodeSel.classed('dim', d => !neighbors.has(d.id));
  linkSel.classed('highlight', d => d.source.id === id || d.target.id === id);
}

function renderDetails(id) {
  const node = nodeById.get(id);
  const inbound = (inboundIndex.get(id) || []).sort((a, b) => b.weight - a.weight);
  const outbound = (outboundIndex.get(id) || []).sort((a, b) => b.weight - a.weight);
  const el = document.getElementById('details');
  el.innerHTML = '<h3>' + id +
    (node.isOrphan ? '<span class="badge badge-orphan">orpheline</span>' : '') +
    (node.isTypo ? '<span class="badge badge-typo">typo ?</span>' : '') + '</h3>' +
    '<div class="sub">Sources distinctes : ' + node.inboundDistinct + '</div>' +
    '<div class="grp"><div class="grp-title">Liens entrants (' + inbound.length + ')</div><ul>' +
    (inbound.length ? inbound.map(e => '<li>' + e.source + ' <span class="sub">(' + e.weight + ')</span></li>').join('') : '<li class="sub">aucun</li>') +
    '</ul></div>' +
    '<div class="grp"><div class="grp-title">Liens sortants (' + outbound.length + ')</div><ul>' +
    (outbound.length ? outbound.map(e => '<li>' + e.target + ' <span class="sub">(' + e.weight + ')</span></li>').join('') : '<li class="sub">aucun</li>') +
    '</ul></div>';
}

svg.on('click', () => { selectedId = null; nodeSel.classed('dim', false); linkSel.classed('highlight', false);
  document.getElementById('details').innerHTML = '<div class="sub">Cliquez sur une page pour voir ses liens entrants / sortants.</div>'; });

document.getElementById('threshold').addEventListener('input', build);
document.querySelectorAll('.cat-filter').forEach(c => c.addEventListener('change', build));
document.getElementById('search').addEventListener('input', (ev) => {
  const q = ev.target.value.trim().toLowerCase();
  if (!q) { nodeSel.classed('dim', false); return; }
  nodeSel.classed('dim', d => !d.id.toLowerCase().includes(q));
});

window.addEventListener('resize', () => {
  width = wrap.clientWidth; height = wrap.clientHeight;
  if (simulation) { simulation.force('center', d3.forceCenter(width / 2, height / 2)); simulation.alpha(0.3).restart(); }
});

build();
</script>
</body>
</html>
`;

writeFileSync(OUTPUT_HTML, html, 'utf8');
console.log(`\n✅ Carte générée : ${OUTPUT_HTML}`);
console.log(`   Ouvrez le fichier dans un navigateur (connexion internet requise pour charger D3.js via CDN).`);
