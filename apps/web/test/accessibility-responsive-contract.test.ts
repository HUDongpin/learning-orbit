import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const packageCssPath = path.resolve(process.cwd(), "app/globals.css");
const repositoryCssPath = path.resolve(process.cwd(), "apps/web/app/globals.css");
const css = readFileSync(existsSync(packageCssPath) ? packageCssPath : repositoryCssPath, "utf8");

function declarationBlock(selector: string): string {
  const marker = `${selector} {`;
  const lineMarker = `\n${marker}`;
  const lineStart = css.indexOf(lineMarker);
  const start = lineStart === -1 ? (css.startsWith(marker) ? 0 : -1) : lineStart + 1;
  expect(start, `missing CSS rule for ${selector}`).toBeGreaterThanOrEqual(0);
  const end = css.indexOf("}", start);
  expect(end, `unterminated CSS rule for ${selector}`).toBeGreaterThan(start);
  return css.slice(start, end + 1);
}

function mediaLayer(maxWidth: number): string {
  const marker = `@media (max-width: ${maxWidth}px) {`;
  const start = css.indexOf(marker);
  expect(start, `missing ${maxWidth}px responsive layer`).toBeGreaterThanOrEqual(0);
  const nextMedia = css.indexOf("\n@media", start + marker.length);
  return css.slice(start, nextMedia === -1 ? css.length : nextMedia);
}

function expectMinimumTarget(selector: string) {
  const block = declarationBlock(selector);
  const height = block.match(/min-(?:height|block-size):\s*(\d+)px/u);
  const width = block.match(/min-(?:width|inline-size):\s*(\d+)px/u);
  expect(height, `${selector} must declare a minimum target height`).not.toBeNull();
  expect(width, `${selector} must declare a minimum target width`).not.toBeNull();
  expect(Number(height?.[1])).toBeGreaterThanOrEqual(44);
  expect(Number(width?.[1])).toBeGreaterThanOrEqual(44);
}

function relativeLuminance(hex: string): number {
  const channels = hex.slice(1).match(/../gu)?.map((pair) => Number.parseInt(pair, 16) / 255) ?? [];
  const [red, green, blue] = channels.map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0);
}

function contrastRatio(first: string, second: string): number {
  const values = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return ((values[0] ?? 0) + 0.05) / ((values[1] ?? 0) + 0.05);
}

describe("static accessibility and responsive CSS contract", () => {
  it("provides authored focus visibility for links as well as form controls", () => {
    expect(css).toContain("a[href]:focus-visible");
    expect(css).toMatch(/outline:\s*3px\s+solid\s+#0b6e99/u);
    expect(css).toMatch(/outline-offset:\s*3px/u);
    expect(css).toContain("--orbit-control-border: #6f8f78");
    expect(contrastRatio("#6f8f78", "#ffffff")).toBeGreaterThanOrEqual(3);
    expect(contrastRatio("#6f8f78", "#fbfefb")).toBeGreaterThanOrEqual(3);
    for (const selector of [
      ".login-field input",
      ".composer textarea",
      ".teacher-secondary, .teacher-link-button",
      ".teacher-form-grid input, .teacher-form-grid textarea, .teacher-form-grid select, .danger-zone input",
    ]) expect(declarationBlock(selector)).toContain("var(--orbit-control-border)");
  });

  it("keeps every currently rendered compact control at least 44 by 44 CSS px", () => {
    for (const selector of [
      ".toolbar button, .toolbar select",
      ".sna-tabs button",
      ".statement-list button",
      ".skip-link",
      ".context-close",
      ".tiny-action",
      ".chip",
      ".icon-button, .send-button",
      ".analysis-state button, .analysis-controls button, .analysis-equivalent-list button",
      ".analysis-switcher button, .analysis-pause",
      ".echo-timeline-controls button, .echo-timeline button",
      ".teacher-create, .teacher-secondary, .teacher-link-button, .teacher-room-link",
      ".local-media audio, .attachment-preview audio",
      ".local-media input, .media-card > label input",
      ".message form textarea",
    ]) expectMinimumTarget(selector);
  });

  it("maps all five required widths to explicit desktop, tablet, and mobile layout layers", () => {
    const breakpoints = [...css.matchAll(/@media \(max-width:\s*(\d+)px\)/gu)]
      .map((match) => Number(match[1]));
    expect(breakpoints).toEqual(expect.arrayContaining([767, 1119]));

    const classify = (width: number) => width <= 767 ? "mobile" : width <= 1119 ? "tablet" : "desktop";
    expect([320, 390, 768, 1024, 1440].map((width) => [width, classify(width)])).toEqual([
      [320, "mobile"],
      [390, "mobile"],
      [768, "tablet"],
      [1024, "tablet"],
      [1440, "desktop"],
    ]);

    expect(declarationBlock(".orbit-grid")).toMatch(/minmax\(0,\s*1fr\).*minmax\(0,\s*1fr\)/u);
    expect(mediaLayer(1119)).toMatch(/\.orbit-grid\s*\{[^}]*grid-template-columns:\s*1fr/u);
    expect(mediaLayer(1119)).toMatch(/\.login-shell\s*\{[^}]*grid-template-columns:\s*1fr/u);
    expect(mediaLayer(767)).toMatch(/\.analysis-column\s*\{[^}]*flex-direction:\s*column/u);
    expect(mediaLayer(767)).toMatch(/\.teacher-room-list\s*>\s*li\s*\{[^}]*grid-template-columns:\s*1fr/u);
  });

  it("contains long untrusted text without relying on page-level horizontal clipping", () => {
    expect(declarationBlock("body")).toMatch(/min-width:\s*320px/u);
    expect(declarationBlock("body")).toMatch(/overflow-wrap:\s*anywhere/u);
    expect(declarationBlock(".login-shell, .teacher-shell, .room-gate-shell")).toMatch(/max-width:\s*100%/u);
    expect(declarationBlock(".orbit-panel")).toMatch(/min-width:\s*0/u);
    expect(declarationBlock(".analysis-content")).toMatch(/min-width:\s*0/u);
  });

  it("removes non-essential motion when reduced motion is requested", () => {
    const reducedMotion = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reducedMotion).toMatch(/animation-duration:\s*\.01ms\s*!important/u);
    expect(reducedMotion).toMatch(/animation-iteration-count:\s*1\s*!important/u);
    expect(reducedMotion).toMatch(/transition-duration:\s*\.01ms\s*!important/u);
    expect(reducedMotion).toMatch(/scroll-behavior:\s*auto\s*!important/u);
  });
});
