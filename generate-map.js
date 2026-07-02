/**
 * Générateur de carte du maillage interne — DevFlows
 * ─────────────────────────────────────────────────────────────────
 * Lit maillage-interne.csv  →  injecte les données dans index.html
 *
 * Lance avec : node generate-map.js
 * ─────────────────────────────────────────────────────────────────
 */

import { readFileSync, writeFileSync } from 'fs';

const INPUT_CSV   = 'maillage-interne.csv';
const OUTPUT_HTML = 'index.html';

// ── Catégorisation améliorée ──────────────────────────────────────
const PILIER_SET = new Set([
  '/agence-n8n', '/automatisation-ia', '/agence-ia', '/audit-ia',
  '/integration-ia', '/creation-agent-ia', '/audit-ia-pour-expert-comptable',
]);

function categoryOf(path) {
  if (path === '/') return 'accueil';
  if (PILIER_SET.has(path)) return 'pilier';
  if (path.startsWith('/post/')) return 'article';
  if (path.startsWith('/use-case/')) return 'cas-usage';
  // Pages locales / SEO géographique
  if (/-(paris|lyon|marseille|nice|bordeaux|france)($|\/)/.test(path) ||
      path.startsWith('/agence-ia-') ||
      (path.startsWith('/agence-webflow/') && path.length > '/agence-webflow'.length))
    return 'local';
  // Contact / légal
  if (path.startsWith('/mentions') || path.startsWith('/politique') ||
      path.startsWith('/contact') || path.startsWith('/rgpd'))
    return 'info';
  // Services & agences (hors piliers IA déjà traités ci-dessus)
  const SVC_PREFIXES = [
    '/developpement-', '/crm-', '/logiciel-', '/ux-ui', '/agence-',
    '/nos-services', '/nos-developpements', '/agent-ia', '/agents-ia',
    '/integration-', '/audit-', '/creation-', '/automatisation-',
    '/generation-', '/tri-', '/expertises/', '/expertise-',
    '/nos-servieces/', '/integrer-', '/ia-low-code', '/simulateur',
    '/boite-a-outil', '/realisations', '/outils', '/blog',
    '/automatisation-workflows',
  ];
  if (SVC_PREFIXES.some(p => path.startsWith(p))) return 'service';
  return 'autre';
}

// ── Parse CSV ─────────────────────────────────────────────────────
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else {
      if      (c === '"')  inQ = true;
      else if (c === ',')  { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ── Lire le CSV ───────────────────────────────────────────────────
console.log('📖 Lecture de', INPUT_CSV, '...');
let csv = readFileSync(INPUT_CSV, 'utf8');
if (csv.charCodeAt(0) === 0xFEFF) csv = csv.slice(1); // BOM

const rows = parseCSV(csv);
const data = rows.slice(1).filter(r => r.length >= 4 && r[0] !== '');

// ── Construire les pages et les arêtes agrégées ───────────────────
const allPaths      = new Set();
const sourcesOfDest = new Map();   // dst → Set(src)
const edgeMap       = new Map();   // "src|||dst" → { source, target, weight, anchors }
const statusByPath   = new Map();  // path → statut HTTP brut (colonne 7 du CSV)

// Un lien est cassé si le statut HTTP de sa destination n'est pas un 2xx/3xx numérique
function isBrokenStatus(status) {
  if (!status) return false;
  const n = Number(status);
  return !Number.isFinite(n) || n >= 400;
}

data.forEach(r => {
  const [src, dst, anchor, type, , , status] = r;
  if (!src || !dst) return;
  allPaths.add(src);
  allPaths.add(dst);
  if (status && !statusByPath.has(dst)) statusByPath.set(dst, status);
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

const nodes = [...allPaths].map(path => {
  const inboundDistinct = sourcesOfDest.get(path)?.size || 0;
  const httpStatus = statusByPath.get(path) || null;
  return {
    id: path,
    category: categoryOf(path),
    label: path,
    inboundDistinct,
    isOrphan: inboundDistinct === 0 && path !== '/',
    isTypo: /servieces/.test(path),
    httpStatus,
    isBroken: isBrokenStatus(httpStatus),
  };
});

const edges = [...edgeMap.values()].map(e => ({
  source: e.source,
  target: e.target,
  weight: e.weight,
  distinctSourcesOfTarget: sourcesOfDest.get(e.target)?.size || 0,
  anchors: [...e.anchors],
  brokenTarget: isBrokenStatus(statusByPath.get(e.target)),
}));

const totalSourcePages = allPaths.size;
const generatedAt = new Date().toISOString();
const brokenCount = nodes.filter(n => n.isBroken).length;

console.log(`✅ Pages : ${nodes.length} | Liens agrégés : ${edges.length} | Liens cassés : ${brokenCount}`);

// Résumé par catégorie
const catCount = {};
nodes.forEach(n => catCount[n.category] = (catCount[n.category] || 0) + 1);
Object.entries(catCount).sort((a,b) => b[1]-a[1]).forEach(([cat, n]) =>
  console.log(`   ${cat.padEnd(12)} : ${n} pages`)
);

// ── Injecter dans index.html ──────────────────────────────────────
// On remplace uniquement la ligne "const DATA = {...};" dans index.html,
// sans toucher au reste du code de visualisation.
console.log('\n📝 Mise à jour de', OUTPUT_HTML, '...');

let html = readFileSync(OUTPUT_HTML, 'utf8');

const payload = { nodes, edges, totalSourcePages, generatedAt, brokenCount };
const newDataLine = `const DATA = ${JSON.stringify(payload)};`;

// Trouver et remplacer la ligne DATA existante
const dataStart = html.indexOf('\nconst DATA = ');
if (dataStart === -1) {
  // Fallback : chercher dans le script
  const altStart = html.indexOf('const DATA = ');
  if (altStart === -1) throw new Error('const DATA = non trouvé dans index.html');
  const altEnd = html.indexOf('\n', altStart);
  html = html.slice(0, altStart) + newDataLine + html.slice(altEnd);
} else {
  const dataEnd = html.indexOf('\n', dataStart + 1);
  html = html.slice(0, dataStart + 1) + newDataLine + html.slice(dataEnd);
}

// Mettre à jour la date affichée dans le sous-titre
const today = new Date().toLocaleDateString('fr-FR');
html = html.replace(
  /devflows\.eu &middot; \d{2}\/\d{2}\/\d{4}/,
  `devflows.eu &middot; ${today}`
);

writeFileSync(OUTPUT_HTML, html, 'utf8');
console.log(`\n✅ ${OUTPUT_HTML} mis à jour — ouvrez dans un navigateur.`);
