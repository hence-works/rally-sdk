/**
 * Metadata pinning.
 *
 * A launch's `metadataURI` must resolve forever — it is frozen onto the token at launch
 * (`RallyToken.metadataURI`, write-once) and emitted in `Launched`. Rally pins it at
 * `/<chainId>/<token>.json`, which is deterministic and collision-free across chains,
 * and which is why the token address has to be known (mined) *before* the launch call.
 *
 * Two ways to get a URI, and an integrator picks per launch:
 *
 *   1. **Bring your own** — pass `metadataURI` to `prepareLaunch`. Host the JSON
 *      wherever you like; nothing here is involved. The layout above is Rally's
 *      convention, not a contract requirement.
 *   2. **Rally's pinning service** — pass `metadata` and configure `metadata:` on the
 *      client. The endpoints are wallet-authenticated (SIWE → JWT), so this costs the
 *      user exactly one extra signature, cached for the session.
 */
import { createSiweMessage } from "viem/siwe";
import type { Address } from "viem";
import { RallyError } from "./errors";
import type { LaunchMetadata } from "./types";

/** Signs the SIWE message — a viem wallet's `signMessage`, or your own. */
export type SignMessageFn = (message: string) => Promise<`0x${string}`>;

export interface MetadataConfig {
  /** The Rally GraphQL gateway, e.g. `https://api.rallypad.fun/graphql`. */
  endpoint: string;
  /**
   * An existing bearer token. Supply one to skip the SIWE handshake entirely — useful
   * for a backend that already holds a session for the launching wallet.
   */
  token?: string;
  /** Called whenever a new session is minted, so hosts can persist it. */
  onSession?: (session: { token: string; address: string; expiresAt: string }) => void;
  /** SIWE `domain`. Defaults to the endpoint's host. */
  domain?: string;
  /** SIWE `uri`. Defaults to the endpoint's origin. */
  uri?: string;
  /** SIWE `statement`. */
  statement?: string;
  /** Custom fetch (proxies, Node < 18, instrumentation). */
  fetch?: typeof globalThis.fetch;
}

export interface PinInput extends LaunchMetadata {
  chainId: number;
  /** The mined CREATE2 address — the pin path must match the address `launch` deploys. */
  tokenAddress: Address;
}

/**
 * A pinning client. `pin` returns the public URL to pass as `metadataURI`.
 * Integrators can implement this interface themselves to route through their own
 * storage while keeping the rest of the launch flow.
 */
export interface MetadataPinner {
  pin(input: PinInput): Promise<string>;
  /** Upload an image and get back its public URL, for `imageUrl` / `bannerUrl`. */
  uploadImage?(file: Blob | ArrayBuffer | Uint8Array, contentType: string): Promise<string>;
}

export interface AuthContext {
  address: Address;
  chainId: number;
  signMessage: SignMessageFn;
}

/**
 * The hosted pinner's full surface. `setAuthContext` is how the client hands over the
 * connected wallet so a pin can mint a session on demand; a custom `MetadataPinner`
 * that doesn't implement it is simply never called with one.
 */
export interface RallyPinner extends MetadataPinner {
  /** Force a SIWE sign-in now (e.g. to front-load the prompt). Returns the JWT. */
  authenticate(ctx: AuthContext): Promise<string>;
  /** The current bearer token, if any. */
  getToken(): string | undefined;
  setAuthContext(ctx: AuthContext): void;
}

/**
 * Rally's hosted pinner. Holds one session in memory and reuses it, so a multi-launch
 * session prompts for a signature once.
 */
export function createRallyPinner(config: MetadataConfig): RallyPinner {
  const doFetch = config.fetch ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new RallyError(
      "METADATA_FAILED",
      "No global fetch available — pass `metadata.fetch` (e.g. node-fetch) explicitly.",
    );
  }

  const endpointUrl = new URL(config.endpoint);
  const domain = config.domain ?? endpointUrl.host;
  const uri = config.uri ?? endpointUrl.origin;
  const statement = config.statement ?? "Sign in to Rally.";

  let token = config.token;
  let authAddress: string | undefined;
  let pendingAuth: Promise<string> | null = null;
  /** The auth context to use when a pin needs a session and none exists. */
  let context: AuthContext | undefined;

  async function gql<T>(query: string, variables: unknown, bearer?: string): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(config.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (cause) {
      throw new RallyError("METADATA_FAILED", `Couldn't reach ${config.endpoint}.`, { cause });
    }
    if (!res.ok) {
      throw new RallyError(
        "METADATA_FAILED",
        `Metadata service responded ${res.status} ${res.statusText}.`,
        { details: { status: res.status } },
      );
    }
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length) {
      const message = body.errors.map((e) => e.message).join("; ");
      const code = /unauthor|forbidden|jwt|token/i.test(message) ? "AUTH_FAILED" : "METADATA_FAILED";
      throw new RallyError(code, message);
    }
    if (!body.data) throw new RallyError("METADATA_FAILED", "Empty response from the metadata service.");
    return body.data;
  }

  async function authenticate(ctx: AuthContext): Promise<string> {
    if (token && authAddress === ctx.address.toLowerCase()) return token;
    // Collapse concurrent callers onto one signature prompt.
    if (pendingAuth) return pendingAuth;

    pendingAuth = (async () => {
      const { siweNonce } = await gql<{ siweNonce: { nonce: string } }>(
        "mutation { siweNonce { nonce } }",
        {},
      );
      const message = createSiweMessage({
        address: ctx.address,
        chainId: ctx.chainId,
        domain,
        uri,
        version: "1",
        nonce: siweNonce.nonce,
        statement,
      });
      const signature = await ctx.signMessage(message);
      const { siweVerify } = await gql<{
        siweVerify: { token: string; address: string; expiresAt: string };
      }>(
        `mutation Verify($input: SiweVerifyInput!) {
           siweVerify(input: $input) { token address expiresAt }
         }`,
        { input: { message, signature } },
      );
      // Bind to the address the gateway recovered from the signature, not the one we
      // sent — that is what the JWT's subject actually says.
      token = siweVerify.token;
      authAddress = siweVerify.address.toLowerCase();
      config.onSession?.(siweVerify);
      return siweVerify.token;
    })();

    try {
      return await pendingAuth;
    } finally {
      pendingAuth = null;
    }
  }

  async function bearer(): Promise<string> {
    if (token) return token;
    if (!context) {
      throw new RallyError(
        "AUTH_FAILED",
        "Pinning needs a session. Pass `metadata.token`, or give the client a wallet so " +
          "the SDK can run the SIWE sign-in.",
      );
    }
    return authenticate(context);
  }

  return {
    authenticate,
    getToken: () => token,

    /** Set by the client before a pin, so `bearer()` can sign in on demand. */
    setAuthContext(ctx: AuthContext) {
      context = ctx;
      if (authAddress && authAddress !== ctx.address.toLowerCase()) {
        token = undefined; // a different wallet must not reuse the previous session
        authAddress = undefined;
      }
    },

    async pin(input: PinInput): Promise<string> {
      const { pinLaunchMetadata } = await gql<{ pinLaunchMetadata: { url: string } }>(
        `mutation Pin($input: LaunchMetadataInput!) {
           pinLaunchMetadata(input: $input) { url }
         }`,
        {
          input: {
            chainId: input.chainId,
            tokenAddress: input.tokenAddress,
            name: input.name,
            symbol: input.symbol,
            description: input.description,
            imageUrl: input.imageUrl,
            bannerUrl: input.bannerUrl,
            website: input.website,
            twitter: input.twitter,
            telegram: input.telegram,
          },
        },
        await bearer(),
      );
      return pinLaunchMetadata.url;
    },

    async uploadImage(file, contentType) {
      const { requestImageUpload } = await gql<{
        requestImageUpload: { uploadUrl: string; publicUrl: string };
      }>(
        `mutation Upload($input: RequestImageUploadInput!) {
           requestImageUpload(input: $input) { uploadUrl publicUrl }
         }`,
        { input: { contentType } },
        await bearer(),
      );
      const put = await doFetch(requestImageUpload.uploadUrl, {
        method: "PUT",
        headers: { "content-type": contentType },
        body: file as BodyInit,
      });
      if (!put.ok) {
        throw new RallyError("METADATA_FAILED", `Image upload failed (${put.status}).`);
      }
      return requestImageUpload.publicUrl;
    },
  };
}

/**
 * Strip undefined/blank fields so the pinned JSON stays clean.
 *
 * The return type keeps `T`'s shape: the required fields are non-blank by the time
 * anything calls this (`prepareLaunch` validates, and the service rejects blanks
 * anyway), so narrowing them to optional here would only push a cast onto callers.
 */
export function cleanMetadata<T extends LaunchMetadata>(meta: T): T {
  const out = {} as T;
  for (const [key, value] of Object.entries(meta)) {
    if (typeof value === "string" && value.trim()) {
      out[key as keyof T] = value.trim() as T[keyof T];
    }
  }
  return out;
}
