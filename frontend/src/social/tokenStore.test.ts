// @vitest-environment jsdom
/**
 * tokenStore tests (DAPP-47) — login tokens persist per (chain, address)
 * identity, address casing is normalized, and dropping a token only affects
 * its own identity.
 */

import { describe, expect, it } from "vitest";
import { dropToken, loadToken, saveToken } from "./tokenStore";

const A = "0x00000000000000000000000000000000000000aA";
const B = "0x00000000000000000000000000000000000000bB";

describe("tokenStore", () => {
  it("round-trips a token per identity", () => {
    saveToken(31337, A, "tok-a");
    expect(loadToken(31337, A)).toBe("tok-a");
  });

  it("normalizes address casing", () => {
    saveToken(31337, A, "tok-a");
    expect(loadToken(31337, A.toLowerCase())).toBe("tok-a");
  });

  it("separates chains and accounts", () => {
    saveToken(31337, A, "tok-a");
    expect(loadToken(11155111, A)).toBeNull();
    expect(loadToken(31337, B)).toBeNull();
  });

  it("drops only its own identity", () => {
    saveToken(31337, A, "tok-a");
    saveToken(31337, B, "tok-b");
    dropToken(31337, A);
    expect(loadToken(31337, A)).toBeNull();
    expect(loadToken(31337, B)).toBe("tok-b");
  });
});
