/**
 * Contract revert decoding tests: ethers-style nested error shapes decode to
 * the rule-level human messages (contract-design v4.1 error set).
 */

import { describe, expect, it } from "vitest";
import { stakeBeastInterface } from "./client";
import { decodeContractError, describeContractError, extractRevertData } from "./errors";
import { classifyTxError } from "../lib/txErrors";

function revertData(name: string, args: unknown[] = []): string {
  return stakeBeastInterface.encodeErrorResult(name, args);
}

describe("extractRevertData", () => {
  it("finds data at error.data (ethers CALL_EXCEPTION)", () => {
    const data = revertData("ZeroStake");
    expect(extractRevertData({ code: "CALL_EXCEPTION", data })).toBe(data);
  });

  it("finds data nested under info.error.data (MetaMask wrap)", () => {
    const data = revertData("ZeroStake");
    expect(extractRevertData({ code: "CALL_EXCEPTION", info: { error: { data } } })).toBe(data);
  });

  it("returns null when there is no revert payload", () => {
    expect(extractRevertData({ code: "ACTION_REJECTED" })).toBeNull();
    expect(extractRevertData(new Error("plain"))).toBeNull();
  });

  it("finds data in an object-valued data wrapper (MetaMask { data: { data } })", () => {
    const data = revertData("CustomPayeeZero");
    expect(extractRevertData({ info: { error: { data: { data } } } })).toBe(data);
  });

  it("finds data in an object-valued result wrapper", () => {
    const data = revertData("CustomPayeeZero");
    expect(extractRevertData({ result: { data } })).toBe(data);
  });

  it("finds data nested under originalError", () => {
    const data = revertData("CustomPayeeZero");
    expect(extractRevertData({ originalError: { data } })).toBe(data);
    expect(extractRevertData({ error: { originalError: { data: { data } } } })).toBe(data);
  });

  it("survives cyclic wrapper structures", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.info = cyclic;
    cyclic.data = cyclic;
    expect(extractRevertData(cyclic)).toBeNull();
  });

  it("describes the same error consistently across every supported wrapper shape", () => {
    const data = revertData("CustomPayeeZero");
    const expected = describeContractError({ code: "CALL_EXCEPTION", data });
    expect(expected).toMatch(/concrete address/);
    expect(describeContractError({ info: { error: { data: { data } } } })).toBe(expected);
    expect(describeContractError({ info: { error: { result: { data } } } })).toBe(expected);
    expect(describeContractError({ originalError: { data } })).toBe(expected);
    expect(describeContractError({ cause: { payload: { data: { data } } } })).toBe(expected);
  });
});

describe("decodeContractError / describeContractError", () => {
  it("decodes parameter-range errors with the rule text", () => {
    const err = { code: "CALL_EXCEPTION", data: revertData("DurationOutOfRange", [2000]) };
    expect(decodeContractError(err)?.name).toBe("DurationOutOfRange");
    expect(describeContractError(err)).toMatch(/between 1 and 1440 minutes/);
  });

  it("decodes R6 combination errors", () => {
    const duel = { code: "CALL_EXCEPTION", data: revertData("DuelTaskParamMismatch") };
    expect(describeContractError(duel)).toMatch(/exactly one task style/);
    const cofocus = { code: "CALL_EXCEPTION", data: revertData("CoFocusPayeeNotCharity", [1]) };
    expect(describeContractError(cofocus)).toMatch(/joint liability/);
    const payee = { code: "CALL_EXCEPTION", data: revertData("PayeeVerifierNotAllowed", [0]) };
    expect(describeContractError(payee)).toMatch(/verifier/);
  });

  it("decodes lifecycle errors (deadlines, roles)", () => {
    const late = { code: "CALL_EXCEPTION", data: revertData("StartDeadlinePassed", [7]) };
    expect(describeContractError(late)).toMatch(/start window has passed/i);
    const notStaker = {
      code: "CALL_EXCEPTION",
      data: revertData("NotStaker", [7, "0x0000000000000000000000000000000000000001"]),
    };
    expect(describeContractError(notStaker)).toMatch(/Only the session creator/);
  });

  it("returns null for unknown selectors", () => {
    expect(decodeContractError({ code: "CALL_EXCEPTION", data: "0xdeadbeef" })).toBeNull();
  });
});

describe("classifyTxError", () => {
  it("keeps user rejection distinct", () => {
    expect(classifyTxError({ code: "ACTION_REJECTED" }).kind).toBe("rejected");
    expect(classifyTxError({ code: 4001 }).kind).toBe("rejected");
  });

  it("keeps insufficient funds distinct", () => {
    expect(classifyTxError({ code: "INSUFFICIENT_FUNDS" }).kind).toBe("insufficient-funds");
  });

  it("maps known reverts to the reverted kind with the rule message", () => {
    const err = { code: "CALL_EXCEPTION", data: revertData("NothingToWithdraw", ["0x0000000000000000000000000000000000000001"]) };
    const c = classifyTxError(err);
    expect(c.kind).toBe("reverted");
    expect(c.detail).toMatch(/no claimable balance/);
  });

  it("falls back to unknown for unrecognized failures", () => {
    const c = classifyTxError({ code: "CALL_EXCEPTION", message: "execution reverted (unknown)" });
    expect(c.kind).toBe("unknown");
  });
});
