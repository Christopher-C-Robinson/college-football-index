const NEUTRAL_PRIMARY = '#255b7a';
const NEUTRAL_SECONDARY = '#df8e5a';
const appearance = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null;
let teamPrimary = NEUTRAL_PRIMARY;
let teamSecondary = NEUTRAL_SECONDARY;

function channels(color) {
  return [1, 3, 5].map(function (start) { return parseInt(color.slice(start, start + 2), 16); });
}
function blend(color, target, amount) {
  const source = channels(color);
  const destination = channels(target);
  return '#' + source.map(function (value, index) {
    return Math.round(value * (1 - amount) + destination[index] * amount).toString(16).padStart(2, '0');
  }).join('');
}
function luminance(color) {
  const linear = channels(color).map(function (value) {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
function contrast(first, second) {
  const light = Math.max(luminance(first), luminance(second));
  const dark = Math.min(luminance(first), luminance(second));
  return (light + 0.05) / (dark + 0.05);
}
function readableColor(color, background, target) {
  for (let step = 0; step <= 100; step += 1) {
    const candidate = blend(color, target, step / 100);
    if (contrast(candidate, background) >= 4.5) return candidate;
  }
  return target;
}
function refreshPalette() {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const dark = Boolean(appearance && appearance.matches);
  const surface = dark ? '#17232f' : '#ffffff';
  // Include muted cards in the text contrast target, not just the page canvas.
  const textSurface = dark ? '#1d2d3b' : '#f3f5f8';
  const contrastTarget = dark ? '#ffffff' : '#172333';
  root.style.setProperty('--blue-mid', readableColor(teamPrimary, textSurface, contrastTarget));
  root.style.setProperty('--blue-light', blend(teamPrimary, dark ? surface : '#f3f2ee', dark ? 0.82 : 0.9));
  root.style.setProperty('--accent', readableColor(teamSecondary, textSurface, contrastTarget));
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = surface;
}

/** Apply team hues to appearance-dependent text and fills, preserving raw colors. */
export function applyDeviceTheme(primary, secondary) {
  teamPrimary = /^#[0-9a-f]{6}$/i.test(primary || '') ? primary : NEUTRAL_PRIMARY;
  teamSecondary = /^#[0-9a-f]{6}$/i.test(secondary || '') ? secondary : NEUTRAL_SECONDARY;
  refreshPalette();
}

if (appearance) {
  if (typeof appearance.addEventListener === 'function') appearance.addEventListener('change', refreshPalette);
  else if (typeof appearance.addListener === 'function') appearance.addListener(refreshPalette);
}
refreshPalette();
