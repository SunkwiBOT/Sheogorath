'use strict';
/**
 * A one-series line chart as a PNG, for an embed's image. Drawn as SVG and
 * rasterised by resvg, so it needs no browser and no system graphics library,
 * only a font (DejaVu Sans on the server, Segoe UI or Arial on Windows).
 *
 * It is laid out at the size Discord shows an embed image, about 440px wide,
 * so the marks and text sizes below are what people see. It is rendered at
 * three times that, which keeps it sharp when someone opens it full size.
 * The palette is dark because most of Discord is.
 *
 * The y axis starts at zero. The shaded area says how much, and a cut-off
 * axis would make every dip look like a crash.
 */
const { Resvg } = require('@resvg/resvg-js');

const W = 440;
const H = 220;
// The side gutters fit DejaVu Sans, the server's font and the widest of the
// three: "$1.25M" on the left, "$330,410" on the right.
const PAD = { top: 14, right: 88, bottom: 26, left: 58 };
const SCALE = 3;
const INK = { surface: '#1a1a19', primary: '#f0efec', muted: '#898781', grid: '#2c2c2a' };
const FONT = "'DejaVu Sans', 'Liberation Sans', 'Segoe UI', Arial, sans-serif";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const r1 = (n) => Math.round(n * 10) / 10;

/**
 * A tick step of 1, 2, 2.5 or 5 times a power of ten, giving three to five
 * gridlines above zero. Of those, the one whose top sits closest above `max`,
 * so the line uses the height it's given, and the fewer lines on a tie.
 */
function niceStep(max) {
  const mag = 10 ** Math.floor(Math.log10(max));
  let best = null;
  for (const m of [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5]) {
    const step = m * mag;
    const count = Math.ceil(max / step - 1e-9);
    if (count < 3 || count > 5) continue;
    const top = count * step;
    if (!best || top < best.top - 1e-9 || (Math.abs(top - best.top) < 1e-9 && count < best.count)) best = { step, top, count };
  }
  return best ? best.step : mag;
}

/**
 * @param {{label: string, value: number}[]} points oldest first, two or more
 * @param {object} opts
 * @param {string} opts.color the line's color
 * @param {(n: number) => string} opts.tick y-axis labels, kept short ($500K)
 * @param {(n: number) => string} opts.end the label beside the last point, in full
 * @returns {Buffer} PNG
 */
function renderLineChart(points, { color, tick, end }) {
  if (!Array.isArray(points) || points.length < 2) throw new Error('A line needs two points');

  const max = Math.max(...points.map((p) => p.value)) || 1;
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (i) => r1(PAD.left + (i / (points.length - 1)) * plotW);
  const y = (v) => r1(PAD.top + plotH - (v / top) * plotH);
  const base = y(0);

  const parts = [];

  // Gridlines and their values. Hairline, solid, one step off the surface.
  for (let v = 0; v <= top + step / 1000; v += step) {
    parts.push(`<line x1="${PAD.left}" x2="${PAD.left + plotW}" y1="${y(v)}" y2="${y(v)}" stroke="${INK.grid}" stroke-width="1"/>`);
    parts.push(`<text x="${PAD.left - 7}" y="${r1(y(v) + 3.8)}" text-anchor="end" font-size="11" fill="${INK.muted}">${esc(tick(v))}</text>`);
  }

  // Dates, counted back from the last point so the latest day is always named.
  // Seven fit across: a week gets every day.
  const every = Math.max(1, Math.ceil(points.length / 7));
  for (let i = points.length - 1; i >= 0; i -= every) {
    parts.push(`<text x="${x(i)}" y="${base + 17}" text-anchor="middle" font-size="11" fill="${INK.muted}">${esc(points[i].label)}</text>`);
  }

  const line = points.map((p, i) => `${x(i)},${y(p.value)}`).join(' L');
  parts.push(`<path d="M${x(0)},${base} L${line} L${x(points.length - 1)},${base} Z" fill="${color}" fill-opacity="0.12"/>`);
  parts.push(`<path d="M${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);

  // Today: a dot with a ring of the surface around it, and its value beside it
  // in the gutter, where the line can never run through the text.
  const last = points[points.length - 1];
  const lx = x(points.length - 1);
  const ly = y(last.value);
  parts.push(`<circle cx="${lx}" cy="${ly}" r="6" fill="${INK.surface}"/>`);
  parts.push(`<circle cx="${lx}" cy="${ly}" r="4" fill="${color}"/>`);
  const labelY = Math.min(Math.max(ly + 4.3, PAD.top + 8), base - 2);
  parts.push(`<text x="${lx + 10}" y="${r1(labelY)}" font-size="12" font-weight="bold" fill="${INK.primary}">${esc(end(last.value))}</text>`);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`
    + `<rect width="${W}" height="${H}" fill="${INK.surface}"/>${parts.join('')}</svg>`;

  return new Resvg(svg, {
    fitTo: { mode: 'width', value: W * SCALE },
    font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' },
  }).render().asPng();
}

module.exports = { renderLineChart, niceStep };
