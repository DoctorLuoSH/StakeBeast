/**
 * colorway — the seven-palette wiring (DAPP-31 notes 8–10), kept in a
 * non-component module so BeastSprite stays a component-only export file.
 *
 * `colorIndex` derives a beast's palette from its on-chain session id
 * (`uint256(sessionId) % 7`; default green = index 3, the lime set); the
 * session page and the zoo shelf share it. `paletteVars` turns an index
 * into the six `--beast-*` custom properties BeastSprite injects inline.
 * Golden never goes through here — it is forcibly gold inside the component.
 */

import palettes from "./palettes.json";

export interface BeastPalette {
  name: string;
  body: string;
  shade: string;
  belly: string;
  feature: string;
  line: string;
  glow: string;
}

export const COLORWAYS: readonly BeastPalette[] = palettes;

export const COLORWAY_COUNT = COLORWAYS.length; // 7

/**
 * Palette index for a session: `Number(BigInt(sessionId) % 7n)`.
 * Accepts the uint256 in decimal or 0x-hex string form (or number/bigint).
 */
export function colorIndex(sessionId: string | number | bigint): number {
  return Number(BigInt(sessionId) % BigInt(COLORWAY_COUNT));
}

/** The six `--beast-*` variables for a palette index (wrapped mod 7). */
export function paletteVars(colorway: number): Record<string, string> {
  const p = COLORWAYS[((colorway % COLORWAY_COUNT) + COLORWAY_COUNT) % COLORWAY_COUNT];
  return {
    "--beast-body": p.body,
    "--beast-shade": p.shade,
    "--beast-belly": p.belly,
    "--beast-feature": p.feature,
    "--beast-line": p.line,
    "--beast-glow": p.glow,
  };
}
