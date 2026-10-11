// Release checks and navigations use the same public website address. Model
// snapshots and live score polling have their own independent refresh paths.
const root = new URL('../', import.meta.url);

function releaseSignature(doc) {
  const app = doc.querySelector('#site-app') || [...doc.querySelectorAll('script[type="module"][src]')]
    .find(script => new URL(script.getAttribute('src'), root).pathname === root.pathname + 'js/app.js');
  if (!app) return null;
  const assets = [app.getAttribute('src'), ...[...doc.querySelectorAll('link[rel="stylesheet"][href]')]
    .map(link => link.getAttribute('href'))].map(path => new URL(path, root).href);
  return assets.sort().join('\n');
}

export function installSiteUpdates() {
  const currentRelease = releaseSignature(document);
  if (!currentRelease) return;
  if ('serviceWorker' in navigator && window.isSecureContext) {
    const workerUrl = new URL('site-worker.js', root).href;
    navigator.serviceWorker.register(workerUrl, {
      scope: root.pathname, updateViaCache: 'none'
    }).then(() => {
      const reportControl = () => {
        document.documentElement.dataset.siteNavigation = navigator.serviceWorker.controller?.scriptURL === workerUrl ? 'fresh' : 'pending';
      };
      navigator.serviceWorker.addEventListener('controllerchange', reportControl);
      reportControl();
    }).catch(() => { /* A blocked worker must not prevent the site from loading. */ });
  }
  let checking = false;
  let notice = null;
  let lastCheck = 0;

  async function checkRelease() {
    if (checking || notice || document.visibilityState === 'hidden' || Date.now() - lastCheck < 30000) return;
    checking = true;
    lastCheck = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(new URL('index.html', root).href, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) return;
      const html = await response.text();
      if (html.length > 512000) return;
      const signature = releaseSignature(new DOMParser().parseFromString(html, 'text/html'));
      if (!signature || signature === currentRelease) return;
      notice = document.createElement('aside');
      notice.className = 'site-update-notice';
      notice.setAttribute('role', 'status');
      const message = document.createElement('span');
      message.textContent = 'A site update is available.';
      const refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.textContent = 'Refresh';
      refresh.addEventListener('click', () => window.location.reload());
      notice.append(message, refresh);
      document.querySelector('.site-header')?.after(notice);
    } catch { /* Retain the usable page when offline or an update check fails. */ }
    finally { clearTimeout(timeout); checking = false; }
  }

  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'hidden') void checkRelease(); });
  window.addEventListener('pageshow', () => void checkRelease());
  // A cached document can have loaded before the pageshow listener was added.
  void checkRelease();
}
