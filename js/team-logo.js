const installedRoots = new WeakSet();
const preparedSvgImages = new WeakSet();

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeLogoUrl(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  // Imports may contain arbitrary metadata. Only image URLs over HTTPS and
  // local team-logo assets are accepted; no markup or executable URL schemes.
  if (/^(?:\.\/|\/)?assets\/team-logos\/[a-z\d][a-z\d_./-]*\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(candidate)
    && !candidate.split('/').includes('..')) return candidate;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function initials(team) {
  const abbreviation = String(team?.abbreviation || '').trim();
  if (abbreviation) return abbreviation.slice(0, 5).toUpperCase();
  const words = String(team?.name || team?.school || '').trim().split(/\s+/).filter(Boolean);
  return words.length ? words.slice(0, 3).map(word => word[0]).join('').toUpperCase() : '—';
}

function preferredLogo(team, size) {
  const source = Array.isArray(team?.logos) ? team.logos : team?.logo ? [team.logo] : [];
  const candidates = source.map(safeLogoUrl).filter(Boolean);
  const target = size * 2;
  const score = url => {
    const dark = /\/logos-dark\//i.test(url) ? 100000 : 0;
    const dimension = Number(url.match(/\/logos(?:-dark)?\/(\d+)\//i)?.[1]);
    if (!dimension) return dark + 10000;
    return dark + (dimension >= target ? dimension - target : 1000 + target - dimension);
  };
  return candidates.sort((first, second) => score(first) - score(second))[0] || null;
}

/** Render a provider logo with visible initials until the image loads. */
export function renderTeamLogo(team, { size = 32, className = '', decorative = true } = {}) {
  const pixels = Number.isFinite(Number(size)) ? Math.max(16, Math.min(128, Math.round(Number(size)))) : 32;
  const name = String(team?.name || team?.school || '').trim();
  const logo = preferredLogo(team, pixels);
  const classes = ['team-logo', ...String(className).split(/\s+/).filter(value => /^[a-z_][a-z\d_-]*$/i.test(value))].join(' ');
  const accessibility = decorative ? ' aria-hidden="true"' : ' role="img" aria-label="' + escapeHtml(name ? name + ' logo' : 'Team logo') + '"';
  return '<span class="' + classes + '" data-team-logo' + (name ? ' data-team-name="' + escapeHtml(name) + '"' : '') + ' data-logo-state="' + (logo ? 'loading' : 'fallback') + '" style="--team-logo-size:' + pixels + 'px"' + accessibility + '>' +
    '<span class="team-logo-fallback">' + escapeHtml(initials(team)) + '</span>' +
    (logo ? '<img class="team-logo-image" src="' + escapeHtml(logo) + '" alt="" width="' + pixels + '" height="' + pixels + '" loading="lazy" decoding="async" referrerpolicy="no-referrer">' : '') + '</span>';
}

/** Render a centered map marker without embedding HTML inside SVG. */
export function renderSvgTeamLogo(team, { size = 18 } = {}) {
  const pixels = Number.isFinite(Number(size)) ? Math.max(16, Math.min(128, Math.round(Number(size)))) : 18;
  const name = String(team?.name || team?.school || '').trim();
  const logo = preferredLogo(team, pixels);
  const edge = -pixels / 2;
  return '<g class="team-logo-svg" data-team-logo data-team-name="' + escapeHtml(name) + '" data-logo-state="' + (logo ? 'loading' : 'fallback') + '" aria-hidden="true">' +
    '<rect class="team-logo-svg-frame" x="' + edge + '" y="' + edge + '" width="' + pixels + '" height="' + pixels + '" rx="3"/>' +
    '<text class="team-logo-svg-fallback" x="0" y="0" text-anchor="middle" dominant-baseline="central" pointer-events="none">' + escapeHtml(initials(team)) + '</text>' +
    (logo ? '<image class="team-logo-svg-image" href="' + escapeHtml(logo) + '" x="' + (edge + 3) + '" y="' + (edge + 3) + '" width="' + (pixels - 6) + '" height="' + (pixels - 6) + '" preserveAspectRatio="xMidYMid meet" pointer-events="none"/>' : '') + '</g>';
}

function updateLogo(image, eventType) {
  const svgImage = image?.matches?.('image.team-logo-svg-image');
  if (!svgImage && !image?.matches?.('img.team-logo-image')) return;
  const wrapper = image.closest('[data-team-logo]');
  if (!wrapper) return;
  if (svgImage) {
    // SVGImageElement has no HTMLImageElement complete/naturalWidth fields.
    if (eventType === 'load' || eventType === 'error') wrapper.dataset.logoState = eventType === 'load' ? 'loaded' : 'fallback';
    return;
  }
  wrapper.dataset.logoState = image.complete && image.naturalWidth > 0 ? 'loaded' : 'fallback';
}

function updateSvgLogoFromEvent(event) {
  updateLogo(event.currentTarget, event.type);
}

function prepareLogos(node) {
  if (!node?.querySelectorAll) return;
  // SVG image events do not consistently reach document capture listeners.
  // Prepare inserted images before their asynchronous resource events arrive.
  const svgImages = [...(node.matches?.('image.team-logo-svg-image') ? [node] : []), ...node.querySelectorAll('image.team-logo-svg-image')];
  for (const image of svgImages) {
    if (preparedSvgImages.has(image)) continue;
    image.addEventListener('load', updateSvgLogoFromEvent);
    image.addEventListener('error', updateSvgLogoFromEvent);
    preparedSvgImages.add(image);
  }
  const logos = [...(node.matches?.('[data-team-logo]') ? [node] : []), ...node.querySelectorAll('[data-team-logo]')];
  for (const logo of logos) {
    const name = logo.dataset.teamName;
    // Ranking rows and the SVG map already provide one keyboard/click action.
    // Keep their logo decorative instead of nesting an interactive control.
    if (!name || logo.closest('svg') || logo.parentElement?.closest('button, a, summary, [role="button"], [role="link"]')) continue;
    logo.classList.add('is-team-link');
    logo.dataset.selectTeam = name;
    logo.setAttribute('role', 'button');
    logo.tabIndex = 0;
    logo.removeAttribute('aria-hidden');
    logo.setAttribute('aria-label', 'Open ' + name + ' in team explorer');
    logo.title = 'Explore ' + name;
  }
  // A cached image can finish before listeners are installed or a later
  // renderer inserts it. The same state update also keeps initials usable.
  const images = [...(node.matches?.('img.team-logo-image') ? [node] : []), ...node.querySelectorAll('img.team-logo-image')];
  for (const image of images) if (image.complete) updateLogo(image);
}

/** Capture image events and prepare team actions, including later renders. */
export function installTeamLogoFallbacks(root = document) {
  if (!root?.addEventListener) return;
  if (!installedRoots.has(root)) {
    root.addEventListener('load', event => updateLogo(event.target, event.type), true);
    root.addEventListener('error', event => updateLogo(event.target, event.type), true);
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) prepareLogos(node);
    }).observe(root, { childList: true, subtree: true });
    installedRoots.add(root);
  }
  prepareLogos(root);
}
