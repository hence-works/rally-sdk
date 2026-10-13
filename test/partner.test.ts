import { describe, expect, it } from "vitest";
import {
  RALLY_PARTNER_REPLAY_WINDOW_SECONDS,
  RALLY_PARTNER_SIGNATURE_HEADER,
  RALLY_PARTNER_SIGNAL_KINDS,
  RALLY_PARTNER_SIGNAL_PHASES,
  RALLY_PARTNER_TIMESTAMP_HEADER,
  parseRallyPartnerSignal,
  signRallyPartnerWebhook,
  verifyRallyPartnerWebhook,
} from "../src";

const NOW = 1_800_000_000;
const SIGNAL = {
  signalId: "sig_01JZZZZZZZZZZZZZZZZZZZZZZZ",
  kind: "ENTER",
  chainId: 4663,
  token: "0x1111111111111111111111111111111111111111",
  pid: `0x${"22".repeat(32)}`,
  quote: "0x3333333333333333333333333333333333333333",
  quoteDecimals: 18,
  phase: "CURVE",
  score: "0.82",
  reasons: ["Bonded quote accelerated over the last five blocks"],
  observedBlock: 60_000_000,
  expiresAt: NOW + 120,
  maxAggregateQuote: "500000000000000000",
};

const VECTOR = {
  timestamp: "1800000000",
  secret: "whsec_shared_vector",
  body: new TextEncoder().encode('{"message":"Rally 🚀"}\n'),
  signature: "sha256=b4230509e7cfe2b7922d4190cd4f09dad155df2943444e61d305cd253efbdf9a",
};

describe("partner webhook authentication", () => {
  it("exports the canonical header names and replay window", () => {
    expect(RALLY_PARTNER_TIMESTAMP_HEADER).toBe("X-Rally-Timestamp");
    expect(RALLY_PARTNER_SIGNATURE_HEADER).toBe("X-Rally-Signature");
    expect(RALLY_PARTNER_REPLAY_WINDOW_SECONDS).toBe(60);
  });

  it("matches the shared deterministic raw-byte vector", async () => {
    await expect(signRallyPartnerWebhook(VECTOR)).resolves.toBe(VECTOR.signature);
    await expect(verifyRallyPartnerWebhook({ ...VECTOR, nowSeconds: NOW })).resolves.toBe(true);
  });

  it("binds the timestamp and exact raw body bytes", async () => {
    await expect(verifyRallyPartnerWebhook({
      ...VECTOR,
      timestamp: String(NOW + 1),
      nowSeconds: NOW,
    })).resolves.toBe(false);
    await expect(verifyRallyPartnerWebhook({
      ...VECTOR,
      body: new TextEncoder().encode('{"message":"Rally 🚀"}'),
      nowSeconds: NOW,
    })).resolves.toBe(false);
  });

  it("accepts 60-second boundaries and rejects older or future timestamps", async () => {
    await expect(verifyRallyPartnerWebhook({ ...VECTOR, nowSeconds: NOW + 60 }))
      .resolves.toBe(true);
    await expect(verifyRallyPartnerWebhook({ ...VECTOR, nowSeconds: NOW - 60 }))
      .resolves.toBe(true);
    await expect(verifyRallyPartnerWebhook({ ...VECTOR, nowSeconds: NOW + 61 }))
      .resolves.toBe(false);
    await expect(verifyRallyPartnerWebhook({ ...VECTOR, nowSeconds: NOW - 61 }))
      .resolves.toBe(false);
  });

  it("rejects non-canonical timestamps and signatures", async () => {
    for (const timestamp of ["01800000000", "+1800000000", "1800000000.0", " 1800000000"]) {
      await expect(verifyRallyPartnerWebhook({ ...VECTOR, timestamp, nowSeconds: NOW }))
        .resolves.toBe(false);
    }
    await expect(verifyRallyPartnerWebhook({
      ...VECTOR,
      signature: `sha256=${VECTOR.signature.slice("sha256=".length).toUpperCase()}`,
      nowSeconds: NOW,
    })).resolves.toBe(false);
    await expect(verifyRallyPartnerWebhook({
      ...VECTOR,
      secret: "wrong-secret",
      nowSeconds: NOW,
    })).resolves.toBe(false);
    await expect(signRallyPartnerWebhook({ ...VECTOR, timestamp: "01800000000" }))
      .rejects.toThrow(/canonical decimal/);
  });
});

describe("parseRallyPartnerSignal", () => {
  it("exports the wire enums from the package entry point", () => {
    expect(RALLY_PARTNER_SIGNAL_KINDS).toEqual(["ENTER", "TRIM", "EXIT", "CANCEL"]);
    expect(RALLY_PARTNER_SIGNAL_PHASES).toEqual(["CURVE", "GRADUATED"]);
  });

  it("accepts ENTER and TRIM and preserves base-unit strings", () => {
    expect(parseRallyPartnerSignal(SIGNAL)).toEqual(SIGNAL);
    expect(parseRallyPartnerSignal({ ...SIGNAL, kind: "TRIM", trimBps: 2_500 }))
      .toMatchObject({ kind: "TRIM", trimBps: 2_500 });
  });

  it("rejects JSON number amounts and trimBps on ENTER", () => {
    expect(() => parseRallyPartnerSignal({ ...SIGNAL, maxAggregateQuote: 123 }))
      .toThrow(/base-unit integer string/);
    expect(() => parseRallyPartnerSignal({ ...SIGNAL, trimBps: 2_500 }))
      .toThrow(/only valid on TRIM/);
  });

  it("requires a distinct targetSignalId only on CANCEL", () => {
    const cancel = {
      ...SIGNAL,
      signalId: "sig_cancel_01JZZZZZZZZZZZZZZZZZZZ",
      kind: "CANCEL",
      targetSignalId: SIGNAL.signalId,
    };
    expect(parseRallyPartnerSignal(cancel)).toEqual(cancel);
    expect(() => parseRallyPartnerSignal({ ...cancel, targetSignalId: undefined }))
      .toThrow(/targetSignalId is required/);
    expect(() => parseRallyPartnerSignal({ ...cancel, targetSignalId: cancel.signalId }))
      .toThrow(/must differ from signalId/);
    expect(() => parseRallyPartnerSignal({ ...SIGNAL, targetSignalId: "sig_other" }))
      .toThrow(/only valid on CANCEL/);
  });

  it("rejects quote decimals the protocol cannot launch and non-line reasons", () => {
    expect(() => parseRallyPartnerSignal({ ...SIGNAL, quoteDecimals: 19 }))
      .toThrow(/quoteDecimals/);
    expect(() => parseRallyPartnerSignal({ ...SIGNAL, reasons: ["first\nsecond"] }))
      .toThrow(/one non-empty line/);
    expect(() => parseRallyPartnerSignal({ ...SIGNAL, reasons: [""] }))
      .toThrow(/one non-empty line/);
  });
});
