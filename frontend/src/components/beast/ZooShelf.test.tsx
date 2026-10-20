// @vitest-environment jsdom
/**
 * ZooShelf rendering-logic tests (DAPP-22 review fix): the sample shelf and
 * the "No beasts yet" empty state must never render together — exactly one
 * of shelf / samples / empty shows for any (beasts, demoMode) combination.
 */

import { describe, expect, it, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ZooShelf } from "./ZooShelf";
import { resolveZooView } from "./zooView";
import type { BeastEntry } from "./zooView";

afterEach(cleanup);

const ONE_BEAST: BeastEntry[] = [
  { id: "real-1", stage: "adult", tier: "adult", metric: "50 min focus", date: "2026-10-19" },
];

describe("resolveZooView", () => {
  it("picks shelf when beasts exist, regardless of demo mode", () => {
    expect(resolveZooView(1, false)).toBe("shelf");
    expect(resolveZooView(3, true)).toBe("shelf");
  });

  it("picks samples only with zero beasts in demo mode", () => {
    expect(resolveZooView(0, true)).toBe("samples");
  });

  it("picks empty only with zero beasts outside demo mode", () => {
    expect(resolveZooView(0, false)).toBe("empty");
  });
});

describe("ZooShelf", () => {
  it("renders real beasts without the empty state or demo note", () => {
    render(<ZooShelf beasts={ONE_BEAST} demoMode={false} />);
    expect(screen.getByText("50 min focus")).toBeTruthy();
    expect(screen.queryByText("No beasts yet")).toBeNull();
    expect(screen.queryByText(/^Demo shelf:/)).toBeNull();
  });

  it("renders the sample shelf in demo mode without the empty state", () => {
    render(<ZooShelf beasts={[]} demoMode={true} />);
    expect(screen.getByText(/^Demo shelf:/)).toBeTruthy();
    expect(screen.getByText("24 min focus")).toBeTruthy();
    expect(screen.getByText("120 min focus")).toBeTruthy();
    expect(screen.queryByText("No beasts yet")).toBeNull();
  });

  it("renders only the empty state with no beasts outside demo mode", () => {
    render(<ZooShelf beasts={[]} demoMode={false} />);
    expect(screen.getByText("No beasts yet")).toBeTruthy();
    expect(screen.queryByText(/^Demo shelf:/)).toBeNull();
    expect(screen.queryByText("24 min focus")).toBeNull();
  });

  it("real beasts win over demo mode (samples suppressed)", () => {
    render(<ZooShelf beasts={ONE_BEAST} demoMode={true} />);
    expect(screen.getByText("50 min focus")).toBeTruthy();
    expect(screen.queryByText(/^Demo shelf:/)).toBeNull();
    expect(screen.queryByText("No beasts yet")).toBeNull();
  });
});
