/**
 * Parse any CSS color string to { r, g, b } using the browser.
 */
export function parseColorToRgb(color) {
  if (!color) return null;
  const probe = document.createElement('span');
  probe.style.color = String(color).trim();
  if (!probe.style.color) return null;

  document.documentElement.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();

  const match = computed.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return null;
  return { r: +match[1], g: +match[2], b: +match[3] };
}

/** Subtle row background from any color input (hex, name, hsl, etc.). */
export function subtleBackground(color, alpha = 0.1) {
  const rgb = parseColorToRgb(color);
  if (!rgb) return null;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}
