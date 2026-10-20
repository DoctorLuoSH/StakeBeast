/**
 * BeastSprite — original geometric "blob beast" (frozen PRD v4.1 §14.2/§14.3).
 *
 * Inline SVG + CSS keyframes only, no external assets (original by
 * construction). Five in-session growth phases — egg → cracked egg →
 * hatchling → near-final → final form — driven by the `progress` fraction;
 * four tier silhouettes per the §4.8 ladder (Sprout / Juvenile / Adult /
 * Golden) and mood overlays (growing, happy, warning, fled → withered,
 * minted). The props are the stable component contract: teammate B's final
 * original artwork swaps in behind the same interface.
 */

import type { CSSProperties } from "react";
import "./BeastSprite.css";

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

/** Feature growth factor within the blob phases: 0 hatchling → 1 final. */
const PHASE_GROWTH = [0, 0, 0, 0.55, 1] as const;

const STAGE_LABEL: Record<BeastStage, string> = {
  sprout: "Sprout",
  young: "Juvenile",
  adult: "Adult",
  golden: "Golden",
};

export function BeastSprite({
  stage,
  tier,
  mood = "growing",
  progress = 0,
  size = 160,
}: BeastSpriteProps) {
  const pct = Math.min(100, Math.max(0, Math.round(progress * 100)));
  // Outcome moods always show the final form; warning freezes the current one.
  const settledForm = mood === "happy" || mood === "minted" || mood === "fled";
  const phase = settledForm ? 4 : growthPhase(progress);
  const growth = PHASE_GROWTH[phase];

  const className = [
    "beast-sprite",
    `beast-sprite--${stage}`,
    `beast-sprite--${mood}`,
  ].join(" ");

  return (
    <div
      className={className}
      style={{ width: size, height: size }}
      role="img"
      data-tier={tier}
      aria-label={`Beast, ${STAGE_LABEL[stage]} tier, ${mood}, growth ${pct}%`}
    >
      <svg className="beast-sprite__svg" viewBox="0 0 120 120" aria-hidden>
        {mood === "fled" ? (
          <FledScene stage={stage} />
        ) : (
          <g key={phase} className="beast-sprite__phase">
            {/* Idle motion lives on this wrapper so keyframes never override
                the inline placement transforms on the figure groups. */}
            <g className="beast-sprite__idle">
              {phase < 2 ? (
                <Egg cracked={phase === 1} />
              ) : (
                <Figure stage={stage} growth={growth} mood={mood} />
              )}
            </g>
          </g>
        )}
        {mood === "happy" || (mood === "minted" && stage === "golden") ? (
          <Sparkles />
        ) : null}
      </svg>
      {mood === "warning" ? <span className="beast-sprite__ring" /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Egg phases (0–1): plain egg, then cracked with eyes peeking out.     */
/* ------------------------------------------------------------------ */

const EGG_SPOTS = [
  { cx: 50, cy: 58, r: 4 },
  { cx: 70, cy: 78, r: 3 },
  { cx: 56, cy: 88, r: 2.4 },
];

function Egg({ cracked }: { cracked: boolean }) {
  if (!cracked) {
    return (
      <g className="beast-sprite__egg">
        <ellipse className="beast__shadow" cx="60" cy="103" rx="26" ry="4" />
        <path
          className="beast__shell"
          d="M60,34 C76,34 88,52 88,71 C88,90 76,102 60,102 C44,102 32,90 32,71 C32,52 44,34 60,34 Z"
        />
        {EGG_SPOTS.map((s) => (
          <circle key={`${s.cx}-${s.cy}`} className="beast__shell-spot" {...s} />
        ))}
      </g>
    );
  }
  return (
    <g className="beast-sprite__egg">
      <ellipse className="beast__shadow" cx="60" cy="103" rx="26" ry="4" />
      {/* Dark interior showing through the lifted cap. */}
      <ellipse className="beast__egg-dark" cx="60" cy="70" rx="27" ry="16" />
      <path
        className="beast__shell"
        d="M32,70 L42,61 L50,71 L58,61 L66,71 L74,61 L82,70 L88,66 C89,88 76,102 60,102 C44,102 31,88 32,70 Z"
      />
      <path
        className="beast__crack"
        d="M32,70 L42,61 L50,71 L58,61 L66,71 L74,61 L82,70 L88,66"
      />
      <g className="beast__egg-cap">
        <path
          className="beast__shell"
          d="M88,66 L82,70 L74,61 L66,71 L58,61 L50,71 L42,61 L32,70 C31,50 44,34 60,34 C76,34 89,48 88,66 Z"
        />
        <circle className="beast__shell-spot" cx="52" cy="46" r="3.4" />
      </g>
      {/* Eyes peeking out of the crack — drawn last so nothing covers them. */}
      <circle className="beast__peek" cx="45" cy="62" r="3" />
      <circle className="beast__peek" cx="59" cy="64" r="3" />
      <circle className="beast__peek-pupil" cx="44.2" cy="61.4" r="1.3" />
      <circle className="beast__peek-pupil" cx="58.2" cy="63.4" r="1.3" />
    </g>
  );
}

/* ------------------------------------------------------------------ */
/* Blob figure (phases 2–4): body + tier features scaled by `growth`.   */
/* ------------------------------------------------------------------ */

interface FigureProps {
  stage: BeastStage;
  /** 0 → bare hatchling blob, 1 → full tier silhouette. */
  growth: number;
  mood: BeastMood;
}

function Figure({ stage, growth, mood }: FigureProps) {
  const adultLike = stage === "adult" || stage === "golden";
  // Hatchlings are small and featureless; adults end up broader.
  const scale = 0.62 + 0.38 * growth;
  const scaleX = adultLike ? scale * 1.08 : scale;
  const figureStyle: CSSProperties = {
    transform: `translate(60px, 102px) scale(${scaleX}, ${scale}) translate(-60px, -102px)`,
  };
  const featureStyle = (origin: string): CSSProperties => ({
    opacity: growth,
    transform: `scale(${0.3 + 0.7 * growth})`,
    transformBox: "fill-box",
    transformOrigin: origin,
  });

  return (
    <g className="beast-sprite__figure" style={figureStyle}>
      {stage !== "sprout" ? (
        <path
          className="beast__tail"
          style={featureStyle("0% 100%")}
          d="M88,84 C100,82 108,74 106,62 C103,72 96,76 86,76 Z"
        />
      ) : null}

      <ellipse className="beast__foot" cx="46" cy="100" rx="9" ry="5" />
      <ellipse className="beast__foot" cx="74" cy="100" rx="9" ry="5" />

      <path
        className="beast__body"
        d="M60,36 C79,36 92,51 92,71 C92,90 79,102 60,102 C41,102 28,90 28,71 C28,51 41,36 60,36 Z"
      />
      <ellipse className="beast__belly" cx="60" cy="84" rx="17" ry="13" />
      <ellipse className="beast__arm" cx="31" cy="76" rx="5" ry="9" transform="rotate(15 31 76)" />
      <ellipse className="beast__arm" cx="89" cy="76" rx="5" ry="9" transform="rotate(-15 89 76)" />

      {stage === "sprout" ? (
        <g className="beast__leaf" style={featureStyle("50% 100%")}>
          <path className="beast__leaf-stem" d="M60,38 C60,32 60,27 60,23" />
          <ellipse cx="52" cy="20" rx="7" ry="4" transform="rotate(-30 52 20)" />
          <ellipse cx="68" cy="20" rx="7" ry="4" transform="rotate(30 68 20)" />
        </g>
      ) : null}

      {adultLike || stage === "young" ? (
        <g className="beast__horns" style={featureStyle("50% 100%")}>
          {adultLike ? (
            <>
              <path d="M44,40 C40,28 44,18 52,14 C50,22 52,30 56,36 Z" />
              <path d="M76,40 C80,28 76,18 68,14 C70,22 68,30 64,36 Z" />
            </>
          ) : (
            <>
              <path d="M45,41 L48,29 L54,38 Z" />
              <path d="M75,41 L72,29 L66,38 Z" />
            </>
          )}
        </g>
      ) : null}

      {stage === "golden" ? (
        <path
          className="beast__crown"
          style={featureStyle("50% 100%")}
          d="M48,31 L52,20 L57,28 L60,17 L63,28 L68,20 L72,31 Z"
        />
      ) : null}

      <g className="beast__eyes">
        <circle className="beast__eye" cx="47" cy="64" r="5.5" />
        <circle className="beast__eye" cx="73" cy="64" r="5.5" />
        <circle className="beast__eye-glint" cx="45.5" cy="62" r="1.7" />
        <circle className="beast__eye-glint" cx="71.5" cy="62" r="1.7" />
      </g>

      {mood === "warning" ? (
        <path className="beast__mouth" d="M53,81 L67,81" />
      ) : mood === "happy" || mood === "minted" ? (
        <path className="beast__mouth" d="M51,77 Q60,89 69,77" />
      ) : (
        <path className="beast__mouth" d="M53,78 Q60,84 67,78" />
      )}
    </g>
  );
}

/* ------------------------------------------------------------------ */
/* Fled scene: runaway dash, dust puffs, then a withered remnant (枯化). */
/* ------------------------------------------------------------------ */

function FledScene({ stage }: { stage: BeastStage }) {
  return (
    <>
      <g className="beast-sprite__runner">
        <Figure stage={stage} growth={1} mood="growing" />
      </g>
      <g className="beast-sprite__dust">
        <circle cx="30" cy="98" r="4" />
        <circle cx="39" cy="100" r="3" />
        <circle cx="23" cy="101" r="2.2" />
      </g>
      <g className="beast-sprite__withered">
        <g transform="translate(60 102) scale(1.25) translate(-60 -102)">
          <ellipse className="beast__dry-patch" cx="60" cy="101" rx="14" ry="3" />
          <path className="beast__wilt-stem" d="M60,101 C60,94 59,90 56,86" />
          <ellipse className="beast__wilt-leaf" cx="53" cy="87" rx="4.5" ry="2.2" transform="rotate(-40 53 87)" />
          <ellipse className="beast__wilt-leaf beast__wilt-leaf--dark" cx="60" cy="91" rx="4" ry="2" transform="rotate(20 60 91)" />
        </g>
      </g>
    </>
  );
}

/* Twinkling four-point stars for celebration / golden shimmer. */
function Sparkles() {
  const star =
    "M0,-6 L1.6,-1.6 L6,0 L1.6,1.6 L0,6 L-1.6,1.6 L-6,0 L-1.6,-1.6 Z";
  const sparks = [
    { x: 24, y: 30, delay: "0s" },
    { x: 98, y: 40, delay: "0.5s" },
    { x: 88, y: 16, delay: "1s" },
  ];
  return (
    <g className="beast-sprite__sparkles">
      {sparks.map((s) => (
        <g key={`${s.x}-${s.y}`} transform={`translate(${s.x} ${s.y})`}>
          <path className="beast__spark" style={{ animationDelay: s.delay }} d={star} />
        </g>
      ))}
    </g>
  );
}
