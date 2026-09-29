'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { compareVersions, pickAsset, parseRelease } = require('../src/update-check');

const ASSETS = [
  'Mailplane-0.2.0-mac-arm64.dmg', 'Mailplane-0.2.0-mac-x64.dmg', 'Mailplane-0.2.0-mac-arm64.zip',
  'Mailplane-0.2.0-windows-setup.exe', 'Mailplane-0.2.0-linux-x64.AppImage', 'Mailplane-0.2.0-linux-amd64.deb',
  'Mailplane-0.2.0-android.apk', 'latest-mac.yml',
].map(name => ({ name, browser_download_url: `https://example.test/${name}` }));

describe('update-check', () => {
  test('compareVersions', () => {
    assert.equal(compareVersions('0.2.0', '0.1.9'), 1);
    assert.equal(compareVersions('v0.1.0', '0.1.0'), 0);
    assert.equal(compareVersions('0.1.0', '0.10.0'), -1);
    assert.equal(compareVersions('1.0.0', '1.0.0-beta.2'), 1);
    assert.equal(compareVersions('1.0', '1.0.0'), 0);
  });

  test('pickAsset finds the installer for each system', () => {
    assert.equal(pickAsset(ASSETS, 'darwin', 'arm64').name, 'Mailplane-0.2.0-mac-arm64.dmg');
    assert.equal(pickAsset(ASSETS, 'darwin', 'x64').name, 'Mailplane-0.2.0-mac-x64.dmg');
    assert.equal(pickAsset(ASSETS, 'win32', 'x64').name, 'Mailplane-0.2.0-windows-setup.exe');
    assert.equal(pickAsset(ASSETS, 'linux', 'x64').name, 'Mailplane-0.2.0-linux-x64.AppImage');
    assert.equal(pickAsset(ASSETS, 'android').name, 'Mailplane-0.2.0-android.apk');
    assert.equal(pickAsset([], 'linux', 'x64'), null);
  });

  test('parseRelease falls back to the release page without a matching file', () => {
    const r = parseRelease({ tag_name: 'v0.2.0', html_url: 'https://github.test/r', body: 'Notes', assets: [] }, 'darwin', 'arm64');
    assert.deepEqual(
      { version: r.version, downloadUrl: r.downloadUrl, notes: r.notes },
      { version: '0.2.0', downloadUrl: 'https://github.test/r', notes: 'Notes' });
    assert.equal(parseRelease({}, 'darwin', 'arm64'), null);
  });
});
