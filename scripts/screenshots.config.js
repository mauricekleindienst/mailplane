'use strict';

// Regenerates the README screenshots in docs/screenshots: `npm run screenshots`
const base = require('../playwright.config');

module.exports = { ...base, testDir: '.', testMatch: 'readme-screenshots.spec.js', outputDir: '../test-results' };
