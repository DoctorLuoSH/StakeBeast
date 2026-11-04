// @vitest-environment jsdom
/**
 * BeastSprite asset-pipeline tests (DAPP-33): real SVG assets replace the
 * placeholder drawing — phase/mood file mapping, hat/crown layering per the
 * DAPP-31 closing terms, per-instance feature hiding while hatted, and the
 * seven-colorway injection with golden forcibly gold.
 */

import { describe, expect, it, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { BeastSprite } from "./BeastSprite";
import { colorIndex, paletteVars, COLORWAY_COUNT } from "./colorway";

afterEach(cleanup);

function renderSprite(props: Parameters<typeof BeastSprite>[0]) {
  const { container } = render(<BeastSprite {...props} />);
  return container;
}

describe("phase → asset mapping", () => {
  it("renders the shared egg at progress 0", () => {
    const c = renderSprite({ stage: "adult", progress: 0 });
    expect(c.querySelector(".beast-sprite__egg")).toBeTruthy();
    expect(c.querySelector(".beast__egg-cap")).toBeNull();
    expect(c.querySelector(".beast-sprite__figure")).toBeNull();
  });

  it("renders the cracked egg with peeking eyes at progress 0.2", () => {
    const c = renderSprite({ stage: "adult", progress: 0.2 });
    expect(c.querySelector(".beast__egg-cap")).toBeTruthy();
    expect(c.querySelector(".beast__peek")).toBeTruthy();
  });

  it("renders the featureless shared hatchling at progress 0.5", () => {
    const c = renderSprite({ stage: "golden", progress: 0.5 });
    expect(c.querySelector(".beast-sprite__figure")).toBeTruthy();
    expect(c.querySelector(".beast__horns")).toBeNull();
    expect(c.querySelector(".beast__leaf")).toBeNull();
    expect(c.querySelector(".beast__crown")).toBeNull();
    expect(c.querySelector(".beast__hat")).toBeNull();
  });

  it("renders the stage nearfinal asset at progress 0.7", () => {
    const c = renderSprite({ stage: "young", progress: 0.7 });
    expect(c.querySelector(".beast-sprite__figure")).toBeTruthy();
    expect(c.querySelector(".beast__body")).toBeTruthy();
  });

  it("renders the final warn variant on warning at the final phase", () => {
    const c = renderSprite({ stage: "adult", mood: "warning", progress: 0.95 });
    // Flat pressed-line mouth from the warn asset, not the neutral smile.
    expect(c.querySelector('.beast__mouth path')?.getAttribute("d")).toBe("M52 83H68");
  });

  it("keeps the frozen phase on warning instead of upgrading it", () => {
    const c = renderSprite({ stage: "adult", mood: "warning", progress: 0.5 });
    // Hatchling phase: neutral hatchling has no horns; warn never upgrades.
    expect(c.querySelector(".beast__horns")).toBeNull();
    expect(c.querySelector(".beast-sprite__figure")).toBeTruthy();
  });
});

describe("hatVisible and feature hiding (DAPP-31 closing terms)", () => {
  it("shows the fedora on adult nearfinal and hides the horns", () => {
    const c = renderSprite({ stage: "adult", progress: 0.7 });
    expect(c.querySelectorAll(".beast__hat").length).toBe(1);
    expect(c.querySelector(".beast__hat-fedora")).toBeTruthy();
    expect(c.querySelector(".beast__horns")).toBeNull();
    // Head stays complete without the feature group.
    expect(c.querySelector(".beast__body")).toBeTruthy();
    expect(c.querySelector(".beast__eyes")).toBeTruthy();
  });

  it("shows the leaf hat on sprout final and hides the leaf group", () => {
    const c = renderSprite({ stage: "sprout", mood: "minted", progress: 1 });
    expect(c.querySelector(".beast__hat-leaf")).toBeTruthy();
    expect(c.querySelector(".beast__leaf")).toBeNull();
    expect(c.querySelector(".beast__leaf-stem")).toBeNull();
  });

  it("shows the beanie on juvenile final", () => {
    const c = renderSprite({ stage: "young", progress: 1 });
    expect(c.querySelector(".beast__hat-beanie")).toBeTruthy();
    expect(c.querySelector(".beast__horns")).toBeNull();
  });

  it("shows no hat before the nearfinal phase", () => {
    for (const progress of [0, 0.2, 0.5]) {
      const c = renderSprite({ stage: "adult", progress });
      expect(c.querySelector(".beast__hat")).toBeNull();
    }
  });

  it("keeps the hat on a warning-frozen phase", () => {
    const c = renderSprite({ stage: "young", mood: "warning", progress: 0.7 });
    expect(c.querySelector(".beast__hat-beanie")).toBeTruthy();
    expect(c.querySelector(".beast-sprite__ring")).toBeTruthy();
  });

  it("never shows a hat on the fled scene", () => {
    const c = renderSprite({ stage: "adult", mood: "fled", progress: 1 });
    expect(c.querySelector(".beast__hat")).toBeNull();
    expect(c.querySelector(".beast-sprite__runner")).toBeTruthy();
    expect(c.querySelector(".beast-sprite__dust")).toBeTruthy();
    expect(c.querySelector(".beast-sprite__withered")).toBeTruthy();
    // The withered remnant is drawn at final size — no 1.7x enlargement.
    expect(c.innerHTML).not.toContain("scale(1.7");
  });
});

describe("golden crown layering", () => {
  it("wears exactly one standalone crown on final, never a hat, horns kept", () => {
    const c = renderSprite({ stage: "golden", mood: "minted", progress: 1 });
    expect(c.querySelectorAll(".beast__crown").length).toBe(1);
    expect(c.querySelector(".beast__hat")).toBeNull();
    expect(c.querySelector(".beast__horns")).toBeTruthy();
  });

  it("wears the nearfinal crown on the nearfinal phase", () => {
    const c = renderSprite({ stage: "golden", progress: 0.7 });
    expect(c.querySelectorAll(".beast__crown").length).toBe(1);
  });

  it("wears no crown before nearfinal", () => {
    const c = renderSprite({ stage: "golden", progress: 0.5 });
    expect(c.querySelector(".beast__crown")).toBeNull();
  });

  it("keeps the crown on a warning-frozen final", () => {
    const c = renderSprite({ stage: "golden", mood: "warning", progress: 1 });
    expect(c.querySelectorAll(".beast__crown").length).toBe(1);
    expect(c.querySelector(".beast__hat")).toBeNull();
  });
});

describe("colorway injection (DAPP-31 notes 8–10)", () => {
  it("injects the six --beast-* variables for a non-golden colorway", () => {
    const c = renderSprite({ stage: "sprout", progress: 1, colorway: 0 });
    const el = c.querySelector(".beast-sprite") as HTMLElement;
    expect(el.style.getPropertyValue("--beast-body")).toBe("#F49B90");
    expect(el.style.getPropertyValue("--beast-feature")).toBe("#B54A40");
    expect(el.style.getPropertyValue("--beast-glow")).toContain("rgba(");
  });

  it("colorway 3 is the default lime set", () => {
    const c = renderSprite({ stage: "adult", progress: 1, colorway: 3 });
    const el = c.querySelector(".beast-sprite") as HTMLElement;
    expect(el.style.getPropertyValue("--beast-body")).toBe("#8BE04E");
  });

  it("never injects colorway variables on golden (forcibly gold)", () => {
    const c = renderSprite({ stage: "golden", progress: 1, colorway: 0 });
    const el = c.querySelector(".beast-sprite") as HTMLElement;
    expect(el.style.getPropertyValue("--beast-body")).toBe("");
    expect(el.style.getPropertyValue("--beast-feature")).toBe("");
  });

  it("injects nothing when colorway is omitted", () => {
    const c = renderSprite({ stage: "sprout", progress: 1 });
    const el = c.querySelector(".beast-sprite") as HTMLElement;
    expect(el.style.getPropertyValue("--beast-body")).toBe("");
  });
});

describe("colorIndex derivation", () => {
  it("is uint256(sessionId) % 7", () => {
    expect(COLORWAY_COUNT).toBe(7);
    expect(colorIndex("0")).toBe(0);
    expect(colorIndex("3")).toBe(3); // default green
    expect(colorIndex("7")).toBe(0);
    expect(colorIndex("8")).toBe(1);
    expect(colorIndex(13)).toBe(6);
  });

  it("handles hex and huge uint256 values", () => {
    expect(colorIndex("0x7")).toBe(0);
    const max = (1n << 256n) - 1n;
    expect(colorIndex(max.toString())).toBe(Number(max % 7n));
  });

  it("paletteVars wraps out-of-range indices", () => {
    expect(paletteVars(7)["--beast-body"]).toBe(paletteVars(0)["--beast-body"]);
  });
});
