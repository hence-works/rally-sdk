/**
 * Generation status. The manifest records every generation a chain has ever had, live or
 * not, with `Status: "active" | "retired"`. Retired means governance closed its factory:
 * its coins still trade, but nothing new launches there. A launch must therefore resolve
 * to an ACTIVE generation, and listing order alone is not the answer.
 */
import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { currentGeneration, generationsOf } from "../src/addresses";
import type { RallyAddresses } from "../src/types";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

function chain(over: Partial<RallyAddresses> = {}): RallyAddresses {
  return {
    chainId: 4663,
    deploymentBlock: 1,
    weth: a(0xe1),
    usdc: a(0xe2),
    poolManager: a(0xe3),
    paramRegistry: a(0x11),
    launchLib: a(0x12),
    launchHook: a(0x13),
    rallyFactory: a(0x14),
    rallyRouter: a(0x15),
    ...over,
  } as RallyAddresses;
}

const v2 = (hook: number, extra: Record<string, unknown> = {}) => ({
  launchHook: a(hook),
  rallyFactory: a(hook + 1),
  rallyRouter: a(hook + 2),
  paramRegistry: a(hook + 3),
  launchLib: a(hook + 4),
  lens: a(hook + 5),
  deploymentBlock: hook,
  ...extra,
});

describe("generation status", () => {
  it("carries each generation's status, and reads a missing one as active", () => {
    const gens = generationsOf(
      chain({
        status: "retired",
        retiredAt: "2026-10-15",
        v2Deployments: [
          v2(0x300, { status: "active", retiredAt: "", indexed: true }),
          v2(0x200, { status: "retired", retiredAt: "2026-10-14", indexed: false }),
          v2(0x100),
        ],
      } as Partial<RallyAddresses>),
    );
    const byHook = Object.fromEntries(gens.map((g) => [g.launchHook, g]));
    expect(byHook[a(0x300)]!.status).toBe("active");
    expect(byHook[a(0x200)]!.status).toBe("retired");
    expect(byHook[a(0x200)]!.retiredAt).toBe("2026-10-14");
    expect(byHook[a(0x200)]!.indexed).toBe(false);
    expect(byHook[a(0x100)]!.status).toBe("active");
    expect(byHook[a(0x100)]!.indexed).toBe(true);
    // The top-level (v1) generation takes the manifest's top-level status.
    expect(byHook[a(0x13)]!.status).toBe("retired");
  });

  it("launches resolve to the newest ACTIVE generation, skipping a retired one first", () => {
    const addresses = chain({
      v2Deployments: [
        v2(0x300, { status: "retired" }),
        v2(0x200, { status: "active" }),
      ],
    } as Partial<RallyAddresses>);
    expect(currentGeneration(addresses, 2)?.launchHook).toBe(a(0x200));
  });

  it("answers undefined when every generation of a protocol is retired", () => {
    const addresses = chain({ status: "retired" } as Partial<RallyAddresses>);
    expect(currentGeneration(addresses, 1)).toBeUndefined();
  });
});
