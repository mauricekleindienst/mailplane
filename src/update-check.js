'use strict';

// Looks up the newest Mailplane release on GitHub. Used where electron-updater
// can't install by itself (unsigned macOS builds, development): the app then
// offers the right download for this computer instead.

const REPO = 'mauricekleindienst/mailplane';

/** Compare "1.2.3" style versions (a leading "v" and "-beta" tails allowed). */
function compareVersions(a, b) {
  const parse = v => {
    const [main, pre = ''] = String(v || '').trim().replace(/^v/i, '').split('-', 2);
    return { nums: main.split('.').map(n => parseInt(n, 10) || 0), pre };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  // 1.0.0 > 1.0.0-beta
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  return x.pre === y.pre ? 0 : (x.pre > y.pre ? 1 : -1);
}

/** Pick the installer that fits this OS / CPU from a release's assets. */
function pickAsset(assets, platform, arch) {
  const names = (assets || []).map(a => ({ name: a.name, url: a.browser_download_url }));
  const find = re => names.find(a => re.test(a.name)) || null;
  if (platform === 'darwin') {
    return find(new RegExp(`mac-${arch === 'arm64' ? 'arm64' : 'x64'}\\.dmg$`)) || find(/\.dmg$/);
  }
  if (platform === 'win32') return find(/windows-setup\.exe$/) || find(/\.exe$/);
  if (platform === 'linux') return find(/\.AppImage$/) || find(/\.deb$/);
  if (platform === 'android') return find(/android\.apk$/) || find(/\.apk$/);
  return null;
}

/** Turn a GitHub release object into what the UI needs. */
function parseRelease(json, platform, arch) {
  if (!json || !json.tag_name) return null;
  const asset = pickAsset(json.assets, platform, arch);
  return {
    version: json.tag_name.replace(/^v/i, ''),
    name: json.name || json.tag_name,
    notes: String(json.body || '').slice(0, 4000),
    pageUrl: json.html_url,
    downloadUrl: asset?.url || json.html_url,
    fileName: asset?.name || null,
    publishedAt: json.published_at || null,
  };
}

async function fetchLatestRelease({ platform = process.platform, arch = process.arch, repo = REPO } = {}) {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'Mailplane' },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;   // no published release yet
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);
  return parseRelease(await res.json(), platform, arch);
}

/** { available, current, latest } — latest is null when nothing is published. */
async function checkForUpdate(currentVersion, opts) {
  const latest = await fetchLatestRelease(opts);
  return { current: currentVersion, latest, available: !!latest && compareVersions(latest.version, currentVersion) > 0 };
}

module.exports = { REPO, compareVersions, pickAsset, parseRelease, fetchLatestRelease, checkForUpdate };
