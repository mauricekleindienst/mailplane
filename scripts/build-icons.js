#!/usr/bin/env node
'use strict';

// Renders assets/icon.svg to PNG (assets/icon.png, 1024px) and a macOS
// .icns (assets/icon.icns) using the Chromium that Playwright already ships.
// Cross-platform — no sips/iconutil needed.   Usage: npm run build:icons

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ASSETS = path.join(__dirname, '..', 'assets');
const SVG = fs.readFileSync(path.join(ASSETS, 'icon.svg'), 'utf8');

// icns entry types that take PNG payloads
const ICNS_TYPES = [
  ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256],
  ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
];

async function renderPng(page, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${SVG.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)}</body></html>`
  );
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

function buildIcns(entries) {
  const chunks = entries.map(([type, png]) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

(async () => {
  const browser = await chromium.launch(fs.existsSync('/opt/pw-browsers/chromium')
    ? { executablePath: '/opt/pw-browsers/chromium' } : {});
  const page = await browser.newPage();
  const cache = new Map();
  const png = async size => {
    if (!cache.has(size)) cache.set(size, await renderPng(page, size));
    return cache.get(size);
  };

  fs.writeFileSync(path.join(ASSETS, 'icon.png'), await png(1024));
  const entries = [];
  for (const [type, size] of ICNS_TYPES) entries.push([type, await png(size)]);
  fs.writeFileSync(path.join(ASSETS, 'icon.icns'), buildIcns(entries));
  await browser.close();
  process.stdout.write('Wrote assets/icon.png and assets/icon.icns\n');
})().catch(err => { console.error(err); process.exit(1); });
