/**
 * Crawler maillage interne — DevFlows
 * ─────────────────────────────────────────────────────────────────
 * Lance avec :  node crawler-maillage-devflows.js
 * Prérequis  :  node >= 18  (fetch natif)  +  npm install cheerio
 *
 * Ce que ça fait :
 *   1. Démarre depuis la homepage de devflows.eu
 *   2. Visite toutes les pages internes (même domaine)
 *   3. Pour chaque page : extrait tous les <a href> internes
 *   4. Exporte trois fichiers :
 *      - maillage-interne.csv  → matrice source / destination / ancre / statut HTTP
 *      - pages-orphelines.csv  → pages jamais pointées depuis une autre page
 *      - liens-casses.csv      → liens internes pointant vers une page en erreur
 *
 * Limites respectées :
 *   - Délai de 600 ms entre chaque requête (pas de ban)
 *   - Max 500 pages crawlées (configurable via MAX_PAGES)
 *   - Ignore les PDFs, images, assets statiques
 *   - Respecte les redirects (suit jusqu'à l'URL finale)
 * ─────────────────────────────────────────────────────────────────
 */

import * as cheerio from 'cheerio';
import { writeFileSync } from 'fs';

// ── CONFIG ──────────────────────────────────────────────────────
const START_URL   = 'https://www.devflows.eu/';
const DOMAIN      = 'devflows.eu';        // inclut www et non-www
const DELAY_MS    = 600;                  // délai entre requêtes
const MAX_PAGES   = 500;                  // sécurité anti-boucle infinie
const OUTPUT_CSV  = 'maillage-interne.csv';
const OUTPUT_ORP  = 'pages-orphelines.csv';
const OUTPUT_BROKEN = 'liens-casses.csv';
const TIMEOUT_MS  = 10_000;

// Extensions à ignorer
const SKIP_EXT = /\.(pdf|jpg|jpeg|png|gif|webp|svg|ico|css|js|woff|woff2|ttf|xml|zip)(\?.*)?$/i;

// Pages piliers et de service DevFlows — pour annotation dans le CSV
const PILIERS = {
  '/agence-n8n'            : 'PILIER n8n',
  '/automatisation-ia'     : 'PILIER automation IA',
  '/agence-ia'             : 'SERVICE agence IA',
  '/audit-ia'              : 'SERVICE audit IA',
  '/integration-ia'        : 'SERVICE intégration IA',
  '/creation-agent-ia'     : 'SERVICE agents IA',
  '/audit-ia-pour-expert-comptable' : 'SERVICE expert-comptable',
};
// ── FIN CONFIG ───────────────────────────────────────────────────

// ── UTILS ────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function normalizeUrl(raw, base) {
  try {
    const u = new URL(raw, base);
    // Ne garder que http/https
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    // Ignorer domaines externes
    if (!u.hostname.includes(DOMAIN)) return null;
    // Ignorer assets
    if (SKIP_EXT.test(u.pathname)) return null;
    // Supprimer fragment et trailing slash sauf racine
    u.hash = '';
    const path = u.pathname.endsWith('/') && u.pathname !== '/'
      ? u.pathname.slice(0, -1)
      : u.pathname;
    return u.origin + path + u.search;
  } catch {
    return null;
  }
}

function urlToPath(url) {
  try { return new URL(url).pathname; } catch { return url; }
}

function annotate(path) {
  return PILIERS[path] || '';
}

function escapeCSV(val) {
  if (val === null || val === undefined) return '';
  const s = String(val).replace(/\r?\n/g, ' ');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
// ── FIN UTILS ────────────────────────────────────────────────────

// ── CRAWLER ──────────────────────────────────────────────────────
const visited   = new Set();   // URLs visitées
const toVisit   = [START_URL]; // file d'attente
const links     = [];          // { source, destination, anchor, type, annotation }
const inboundCount = {};       // nb de liens reçus par URL
const statusMap = new Map();   // path → { status, error } (résultat final après redirects)

async function fetchPage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal : ctrl.signal,
      headers: { 'User-Agent': 'DevFlows-SEO-Crawler/1.0 (internal audit)' },
      redirect: 'follow',
    });
    clearTimeout(timer);
    const finalUrl = res.url;  // URL après redirects
    const status   = res.status;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return { html: null, finalUrl, status, error: null };
    const html = await res.text();
    return { html, finalUrl, status, error: null };
  } catch (err) {
    clearTimeout(timer);
    console.warn(`  ✗ Erreur sur ${url} : ${err.message}`);
    return { html: null, finalUrl: url, status: null, error: err.message };
  }
}

async function crawl() {
  console.log(`\n🔍 Démarrage du crawl — ${START_URL}`);
  console.log(`   Délai : ${DELAY_MS}ms | Max pages : ${MAX_PAGES}\n`);

  while (toVisit.length > 0 && visited.size < MAX_PAGES) {
    const url = toVisit.shift();
    const normUrl = normalizeUrl(url, START_URL);
    if (!normUrl || visited.has(normUrl)) continue;

    visited.add(normUrl);
    const path = urlToPath(normUrl);
    const anno = annotate(path);
    console.log(`[${visited.size}/${MAX_PAGES}] ${path}${anno ? '  ← ' + anno : ''}`);

    const { html, finalUrl, status, error } = await fetchPage(normUrl);
    statusMap.set(path, { status, error });

    if (error) {
      console.log(`     ✗ ÉCHEC : ${error}`);
    } else if (status >= 400) {
      console.log(`     ⚠ HTTP ${status}`);
    }

    // Si redirect vers URL différente, enregistrer le redirect
    const normFinal = normalizeUrl(finalUrl, START_URL);
    if (normFinal && normFinal !== normUrl) {
      links.push({
        source     : path,
        destination: urlToPath(normFinal),
        anchor     : '[REDIRECT 301]',
        type       : 'redirect',
        annotation : annotate(urlToPath(normFinal)),
      });
    }

    if (!html) { await sleep(DELAY_MS); continue; }

    const $ = cheerio.load(html);

    // ── Extraire les <a href> hors nav/header/footer ──────────────
    // Les liens dans ces zones sont des liens de template répétés sur
    // toutes les pages — ils ne reflètent pas le maillage éditorial.
    const NAV_SEL = [
      'nav', 'header', 'footer',
      '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
      '[class*="navbar"]', '[class*="nav-bar"]', '[class*="site-nav"]',
      '[class*="footer"]', '[class*="site-footer"]',
    ].join(', ');

    let navSkipped = 0;

    $('a[href]').each((_, el) => {
      // Ignorer les liens dans les conteneurs de navigation / footer
      if ($(el).closest(NAV_SEL).length) { navSkipped++; return; }

      const href   = $(el).attr('href') || '';
      const anchor = $(el).text().trim().replace(/\s+/g, ' ').slice(0, 120);
      const destUrl = normalizeUrl(href, normUrl);

      if (!destUrl) return;                      // externe ou asset
      const destPath = urlToPath(destUrl);

      // Comptage liens entrants
      inboundCount[destPath] = (inboundCount[destPath] || 0) + 1;

      // Enregistrer le lien
      links.push({
        source     : path,
        destination: destPath,
        anchor     : anchor || '[vide]',
        type       : 'interne',
        annotation : annotate(destPath),
      });

      // Ajouter à la file si pas encore visité
      if (!visited.has(destUrl) && !toVisit.includes(destUrl)) {
        toVisit.push(destUrl);
      }
    });

    if (navSkipped > 0)
      console.log(`     ↳ ${navSkipped} liens nav/footer ignorés`);

    await sleep(DELAY_MS);
  }

  console.log(`\n✅ Crawl terminé — ${visited.size} pages visitées, ${links.length} liens collectés`);
}
// ── FIN CRAWLER ──────────────────────────────────────────────────

// ── Statut HTTP d'une destination (après résolution des redirects) ─
function destStatus(destPath) {
  const s = statusMap.get(destPath);
  if (!s) return 'non vérifié';               // hors périmètre du crawl (ex: MAX_PAGES atteint)
  if (s.error) return `ERREUR (${s.error})`;
  return String(s.status);
}

function isBrokenStatus(destPath) {
  const s = statusMap.get(destPath);
  if (!s) return false;                       // inconnu ≠ cassé, on ne peut pas l'affirmer
  if (s.error) return true;
  return s.status >= 400;
}

// ── EXPORT CSV ───────────────────────────────────────────────────
function exportCSV() {
  // ── Fichier 1 : matrice complète des liens ──
  const header1 = ['Source', 'Destination', 'Ancre', 'Type', 'Annotation cible', 'Nb liens entrants vers destination', 'Statut HTTP destination'];
  const rows1   = links.map(l => [
    l.source,
    l.destination,
    l.anchor,
    l.type,
    l.annotation,
    inboundCount[l.destination] || 0,
    destStatus(l.destination),
  ]);

  const csv1 = [header1, ...rows1]
    .map(row => row.map(escapeCSV).join(','))
    .join('\n');

  writeFileSync(OUTPUT_CSV, '\uFEFF' + csv1, 'utf8');   // BOM pour Excel français
  console.log(`\n📄 Export : ${OUTPUT_CSV}  (${rows1.length} liens)`);

  // ── Fichier 2 : pages orphelines ──
  // Une page est orpheline si aucune autre page interne ne pointe vers elle
  const allVisited = [...visited].map(urlToPath);
  const orphelines = allVisited.filter(p => !inboundCount[p] || inboundCount[p] === 0);

  const header2 = ['Page orpheline', 'Annotation', 'Priorité'];
  const rows2   = orphelines.map(p => [
    p,
    annotate(p),
    PILIERS[p] ? '🔴 CRITIQUE' : '',
  ]);

  const csv2 = [header2, ...rows2]
    .map(row => row.map(escapeCSV).join(','))
    .join('\n');

  writeFileSync(OUTPUT_ORP, '\uFEFF' + csv2, 'utf8');
  console.log(`📄 Export : ${OUTPUT_ORP}  (${rows2.length} pages orphelines)`);

  // ── Fichier 3 : liens internes cassés ──
  // Un lien est cassé si sa destination (après redirects) répond en erreur
  // HTTP (4xx/5xx) ou n'a pas pu être jointe du tout.
  const brokenLinks = links.filter(l => l.type === 'interne' && isBrokenStatus(l.destination));

  const header3 = ['Page source', 'Lien cassé (destination)', 'Ancre', 'Statut HTTP'];
  const rows3   = brokenLinks.map(l => [l.source, l.destination, l.anchor, destStatus(l.destination)]);

  const csv3 = [header3, ...rows3]
    .map(row => row.map(escapeCSV).join(','))
    .join('\n');

  writeFileSync(OUTPUT_BROKEN, '\uFEFF' + csv3, 'utf8');
  console.log(`📄 Export : ${OUTPUT_BROKEN}  (${rows3.length} liens cassés)`);

  // ── Résumé console ──
  console.log('\n─────────────────────────────────────────');
  console.log('RÉSUMÉ MAILLAGE INTERNE');
  console.log('─────────────────────────────────────────');
  console.log(`Pages crawlées        : ${visited.size}`);
  console.log(`Liens internes totaux : ${links.filter(l => l.type === 'interne').length}`);
  console.log(`Redirects détectés    : ${links.filter(l => l.type === 'redirect').length}`);
  console.log(`Pages orphelines      : ${orphelines.length}`);
  console.log(`Liens cassés          : ${brokenLinks.length}`);

  console.log('\nPages piliers — liens entrants reçus :');
  Object.entries(PILIERS).forEach(([path, label]) => {
    const nb = inboundCount[path] || 0;
    const flag = nb === 0 ? ' ⚠ AUCUN LIEN ENTRANT' : nb < 3 ? ' ⚠ sous-alimenté' : '';
    console.log(`  ${label.padEnd(30)} ${String(nb).padStart(3)} lien(s)${flag}`);
  });
  console.log('─────────────────────────────────────────\n');
}
// ── FIN EXPORT ───────────────────────────────────────────────────

// ── POINT D'ENTRÉE ───────────────────────────────────────────────
(async () => {
  await crawl();
  exportCSV();
})();
