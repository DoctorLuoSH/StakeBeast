/**
 * BeastSprite — beast renderer driven by teammate B's real SVG assets
 * (frozen PRD v4.1 §14.2/§14.3; integration per the DAPP-30 six-note memo
 * and the DAPP-31 closing terms).
 *
 * Five in-session growth phases — egg → cracked egg → hatchling →
 * near-final → final form — driven by the `progress` fraction; the phase and
 * mood select the asset file (no placeholder drawing left). Assets are
 * inlined as SVG markup (never `<img>`) so the page CSS variables and
 * animation hooks reach inside. Assets are drawn at their final target
 * proportions — no growth scaling, no built-in crown branch, no withered
 * enlargement; only wrapper-layer motion (phase-in / breathe / wobble /
 * warn-shake / run) remains.
 *
 * Headwear (DAPP-31): `hatVisible = phase ∈ {nearfinal, final} && stage ≠
 * golden && mood ≠ fled` (a warning-frozen phase keeps its hat). While the
 * hat shows, the conflicting head feature group is hidden per instance
 * (sprout → `beast__leaf`, juvenile/adult → `beast__horns`; golden never
 * hides). Golden only ever wears the standalone crown layer (final crown /
 * nearfinal crown), never a regular hat.
 *
 * Colorway (DAPP-31 notes 8–10): the optional `colorway` prop (0–6) injects
 * one of the seven palettes from ./palettes.json as inline `--beast-*`
 * variables on the root element. Golden is forcibly gold — no colorway
 * variables are ever injected for `stage="golden"` (the `.beast-sprite--golden`
 * CSS cannot defend itself against attribute-level injection).
 */

import type { CSSProperties } from "react";
import "./BeastSprite.css";
import { paletteVars } from "./colorway";

/* Real asset files, inlined as raw markup (Vite `?raw`). */
import eggRaw from "./assets/beast_shared_egg.svg?raw";
import crackedRaw from "./assets/beast_shared_cracked.svg?raw";
import hatchlingNeutralRaw from "./assets/beast_shared_hatchling_neutral.svg?raw";
import hatchlingHappyRaw from "./assets/beast_shared_hatchling_happy.svg?raw";

import sproutNearfinalRaw from "./assets/beast_sprout_nearfinal_neutral.svg?raw";
import juvenileNearfinalRaw from "./assets/beast_juvenile_nearfinal_neutral.svg?raw";
import adultNearfinalRaw from "./assets/beast_adult_nearfinal_neutral.svg?raw";
import goldenNearfinalRaw from "./assets/beast_golden_nearfinal_neutral.svg?raw";

import sproutFinalNeutralRaw from "./assets/beast_sprout_final_neutral.svg?raw";
import sproutFinalHappyRaw from "./assets/beast_sprout_final_happy.svg?raw";
import sproutFinalWarnRaw from "./assets/beast_sprout_final_warn.svg?raw";
import juvenileFinalNeutralRaw from "./assets/beast_juvenile_final_neutral.svg?raw";
import juvenileFinalHappyRaw from "./assets/beast_juvenile_final_happy.svg?raw";
import juvenileFinalWarnRaw from "./assets/beast_juvenile_final_warn.svg?raw";
import adultFinalNeutralRaw from "./assets/beast_adult_final_neutral.svg?raw";
import adultFinalHappyRaw from "./assets/beast_adult_final_happy.svg?raw";
import adultFinalWarnRaw from "./assets/beast_adult_final_warn.svg?raw";
import goldenFinalNeutralRaw from "./assets/beast_golden_final_neutral.svg?raw";
import goldenFinalHappyRaw from "./assets/beast_golden_final_happy.svg?raw";
import goldenFinalWarnRaw from "./assets/beast_golden_final_warn.svg?raw";

import hatLeafNearfinalRaw from "./assets/beast_hat_leaf_nearfinal.svg?raw";
import hatLeafFinalRaw from "./assets/beast_hat_leaf_final.svg?raw";
import hatBeanieNearfinalRaw from "./assets/beast_hat_beanie_nearfinal.svg?raw";
import hatBeanieFinalRaw from "./assets/beast_hat_beanie_final.svg?raw";
import hatFedoraNearfinalRaw from "./assets/beast_hat_fedora_nearfinal.svg?raw";
import hatFedoraFinalRaw from "./assets/beast_hat_fedora_final.svg?raw";
import crownRaw from "./assets/beast_golden_crown.svg?raw";
import crownNearfinalRaw from "./assets/beast_golden_crown_nearfinal.svg?raw";

import dustRaw from "./assets/fx_dust.svg?raw";
import sparkRaw from "./assets/fx_spark.svg?raw";
import witheredRaw from "./assets/fx_withered.svg?raw";

/** Growth stage per baseline §4.8 tier ladder (focus minutes / habit days). */
export type BeastStage = "sprout" | "young" | "adult" | "golden";

/** NFT tier naming from §4.8: 练习苗 / 幼兽 / 成兽 / 黄金兽. */
export type BeastTier = "seedling" | "young" | "adult" | "golden";

/** Lifecycle visual state. */
export type BeastMood = "growing" | "happy" | "warning" | "fled" | "minted";

interface BeastSpriteProps {
  stage: BeastStage;
  tier?: BeastTier;
  mood?: BeastMood;
  /** 0–1 growth progress within the current session; drives growth phases. */
  progress?: number;
  size?: number;
  /**
   * Seven-palette index (0–6, `colorIndex(sessionId)`); injected as inline
   * `--beast-*` variables. Ignored for golden, which is forcibly gold.
   */
  colorway?: number;
}

/** Phase thresholds for in-session growth (PRD §14.2: 5 stages). */
const PHASE_EDGES = [0.15, 0.4, 0.65, 0.9] as const;

function growthPhase(progress: number): number {
  let phase = 0;
  for (const edge of PHASE_EDGES) {
    if (progress >= edge) phase += 1;
  }
  return phase; // 0 egg · 1 cracked · 2 hatchling · 3 near-final · 4 final
}

const STAGE_LABEL: Record<BeastStage, string> = {
  sprout: "Sprout",
  young: "Juvenile",
  adult: "Adult",
  golden: "Golden",
};

/* ------------------------------------------------------------------ */
/* Asset resolution: phase + mood + stage → raw SVG markup.            */
/* ------------------------------------------------------------------ */

/** Asset file stems use "juvenile" where the component API says "young". */
type AssetStage = "sprout" | "juvenile" | "adult" | "golden";

const ASSET_STAGE: Record<BeastStage, AssetStage> = {
  sprout: "sprout",
  young: "juvenile",
  adult: "adult",
  golden: "golden",
};

const NEARFINAL: Record<AssetStage, string> = {
  sprout: sproutNearfinalRaw,
  juvenile: juvenileNearfinalRaw,
  adult: adultNearfinalRaw,
  golden: goldenNearfinalRaw,
};

const FINAL: Record<AssetStage, Record<"neutral" | "happy" | "warn", string>> = {
  sprout: { neutral: sproutFinalNeutralRaw, happy: sproutFinalHappyRaw, warn: sproutFinalWarnRaw },
  juvenile: { neutral: juvenileFinalNeutralRaw, happy: juvenileFinalHappyRaw, warn: juvenileFinalWarnRaw },
  adult: { neutral: adultFinalNeutralRaw, happy: adultFinalHappyRaw, warn: adultFinalWarnRaw },
  golden: { neutral: goldenFinalNeutralRaw, happy: goldenFinalHappyRaw, warn: goldenFinalWarnRaw },
};

/** Hat allocation per spec: sprout→leaf, juvenile→beanie, adult→fedora;
    golden never wears a regular hat (standalone crown only). */
const HAT_BY_STAGE: Record<BeastStage, { nearfinal: string; final: string } | null> = {
  sprout: { nearfinal: hatLeafNearfinalRaw, final: hatLeafFinalRaw },
  young: { nearfinal: hatBeanieNearfinalRaw, final: hatBeanieFinalRaw },
  adult: { nearfinal: hatFedoraNearfinalRaw, final: hatFedoraFinalRaw },
  golden: null,
};

/**
 * Figure markup for the current phase. Mood only picks an expression
 * variant — a warning never upgrades the phase (asset list §3: the `warn`
 * variant exists for the final phase only; earlier phases reuse neutral).
 */
function figureMarkup(stage: BeastStage, phase: number, mood: BeastMood): string {
  if (phase === 0) return eggRaw;
  if (phase === 1) return crackedRaw;
  if (phase === 2) {
    return mood === "happy" || mood === "minted" ? hatchlingHappyRaw : hatchlingNeutralRaw;
  }
  const asset = ASSET_STAGE[stage];
  if (phase === 3) return NEARFINAL[asset];
  if (mood === "warning") return FINAL[asset].warn;
  if (mood === "happy" || mood === "minted") return FINAL[asset].happy;
  return FINAL[asset].neutral;
}

/**
 * Renders one asset file's inner markup. The outer `<svg>` wrapper is
 * stripped — its root defaults live on the carrier `<svg>` below — and the
 * remaining single root group is inlined so CSS hooks apply.
 */
function InlineAsset({ raw }: { raw: string }) {
  const inner = raw.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  // Assets are original, build-time-bundled files verified free of scripts.
  return <g dangerouslySetInnerHTML={{ __html: inner }} />;
}

/**
 * Removes one top-level feature group (e.g. `beast__leaf`, `beast__horns`)
 * from asset markup while a hat sits over it — the conditional-render half
 * of the DAPP-31 hat contract. Groups may nest (leaf → leaf-stem), so the
 * close tag is found by balancing `<g>` / `</g>` from the class match.
 */
function stripFeatureGroup(markup: string, groupClass: string): string {
  const start = markup.indexOf(`<g class="${groupClass}"`);
  if (start === -1) return markup;
  const tag = /<g\b|<\/g>/g;
  tag.lastIndex = start;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(markup)) !== null) {
    depth += m[0] === "<g" ? 1 : -1;
    if (depth === 0) {
      return markup.slice(0, start) + markup.slice(tag.lastIndex);
    }
  }
  return markup;
}

/** Head feature group hidden while the hat shows (golden never hides). */
const HAT_HIDES: Partial<Record<BeastStage, string>> = {
  sprout: "beast__leaf",
  young: "beast__horns",
  adult: "beast__horns",
};

export function BeastSprite({
  stage,
  tier,
  mood = "growing",
  progress = 0,
  size = 160,
  colorway,
}: BeastSpriteProps) {
  const pct = Math.min(100, Math.max(0, Math.round(progress * 100)));
  // Outcome moods always show the final form; warning freezes the current one.
  const settledForm = mood === "happy" || mood === "minted" || mood === "fled";
  const phase = settledForm ? 4 : growthPhase(progress);

  // DAPP-31 closing terms: hats on nearfinal/final only, never on golden,
  // never on the fled scene; a warning-frozen phase keeps its hat.
  const hatVisible =
    mood !== "fled" && stage !== "golden" && (phase === 3 || phase === 4);
  // Golden wears only the standalone crown layer (1:1 same-viewBox overlay,
  // zero positioning math), and only once the form has a head to seat it on.
  const crownVisible =
    mood !== "fled" && stage === "golden" && (phase === 3 || phase === 4);

  const className = [
    "beast-sprite",
    `beast-sprite--${stage}`,
    `beast-sprite--${mood}`,
  ].join(" ");

  // Golden is forcibly gold: colorway variables are never injected for it,
  // because attribute-level inline style would override the golden CSS.
  const style: CSSProperties = { width: size, height: size };
  if (colorway !== undefined && stage !== "golden") {
    Object.assign(style, paletteVars(colorway));
  }

  let figure = figureMarkup(stage, phase, mood);
  if (hatVisible) {
    const hidden = HAT_HIDES[stage];
    if (hidden) figure = stripFeatureGroup(figure, hidden);
  }

  const hatEntry = HAT_BY_STAGE[stage];
  const hat = hatVisible && hatEntry ? hatEntry[phase === 4 ? "final" : "nearfinal"] : null;
  const crown = crownVisible ? (phase === 4 ? crownRaw : crownNearfinalRaw) : null;

  return (
    <div
      className={className}
      style={style}
      role="img"
      data-tier={tier}
      aria-label={`Beast, ${STAGE_LABEL[stage]} tier, ${mood}, growth ${pct}%`}
    >
      {/* Carrier root defaults per the integration memo: fill="none",
          stroke-width 2.25, round caps/joins; assets override per element. */}
      <svg
        className="beast-sprite__svg"
        viewBox="0 0 120 120"
        fill="none"
        strokeWidth={2.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {mood === "fled" ? (
          <>
            {/* Runaway dash: the final neutral form sprints off... */}
            <g className="beast-sprite__runner">
              <InlineAsset raw={FINAL[ASSET_STAGE[stage]].neutral} />
            </g>
            <InlineAsset raw={dustRaw} />
            {/* ...leaving the withered remnant, drawn at final size. */}
            <InlineAsset raw={witheredRaw} />
          </>
        ) : (
          <g key={phase} className="beast-sprite__phase">
            {/* Idle motion lives on this wrapper so keyframes never fight
                the asset geometry; hat / crown ride the same wrapper. */}
            <g className="beast-sprite__idle">
              <InlineAsset raw={figure} />
              {hat ? <InlineAsset raw={hat} /> : null}
              {crown ? <InlineAsset raw={crown} /> : null}
            </g>
          </g>
        )}
        {mood === "happy" || (mood === "minted" && stage === "golden") ? (
          <InlineAsset raw={sparkRaw} />
        ) : null}
      </svg>
      {mood === "warning" ? <span className="beast-sprite__ring" /> : null}
    </div>
  );
}
