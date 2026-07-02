import { chromium } from 'playwright';
import path from 'path';

const filePath = 'file:///' + path.resolve('index.html').replace(/\\/g, '/');

const errors = [];
const consoleMsgs = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('console', msg => consoleMsgs.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', err => errors.push(err.message));

await page.goto(filePath);
await page.waitForTimeout(2500);

const statPages = await page.textContent('#stat-pages');
const statEdges = await page.textContent('#stat-edges');
const statVisible = await page.textContent('#stat-vis');
const statOrphan = await page.textContent('#stat-orp');
const statBroken = await page.textContent('#stat-broken');
const nodeCount = await page.locator('circle.node').count();
const linkCount = await page.locator('line.link').count();

console.log('STATS:', { statPages, statEdges, statVisible, statOrphan, statBroken, nodeCount, linkCount });

await page.screenshot({ path: '.verify-screenshot-1-initial.png' });

const firstNode = page.locator('circle.node').first();
await firstNode.click({ force: true });
await page.waitForTimeout(300);
const detailsHtml = await page.locator('#details').innerHTML();
console.log('DETAILS AFTER CLICK (first 400 chars):', detailsHtml.slice(0, 400));

await page.screenshot({ path: '.verify-screenshot-2-clicked.png' });

await page.uncheck('#nav-toggle');
await page.fill('#threshold', '5');
await page.dispatchEvent('#threshold', 'input');
await page.waitForTimeout(2000);
const statVisible2 = await page.textContent('#stat-vis');
console.log('After lowering threshold to 5, visible edges:', statVisible2);
await page.screenshot({ path: '.verify-screenshot-3-filtered.png' });

await page.fill('#search', '/post/n8n-vs-make');
await page.waitForTimeout(300);
const dimCount = await page.locator('circle.node.dim').count();
const totalNodeCount = await page.locator('circle.node').count();
console.log('Search dim count:', dimCount, '/', totalNodeCount);

console.log('CONSOLE MESSAGES:', JSON.stringify(consoleMsgs, null, 2));
console.log('PAGE ERRORS:', JSON.stringify(errors, null, 2));

await browser.close();
