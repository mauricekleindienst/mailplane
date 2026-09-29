'use strict';

// Regenerates the README screenshots in docs/screenshots: `npm run screenshots`
const base = require('../playwright.config');

// Render the macOS window layout (traffic lights on the left) for the screenshots
process.env.MAILPLANE_PLATFORM = process.env.MAILPLANE_PLATFORM || 'darwin';

module.exports = { ...base, testDir: '.', testMatch: 'readme-screenshots.spec.js', outputDir: '../test-results' };
