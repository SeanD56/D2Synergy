/**
 * Manifest fetch — step 2 of the ingestion pipeline.
 *
 * Wraps `fetch` as a `bungie-api-ts` HttpClient (adding the `X-API-Key`
 * header), reads the current Manifest version, compares it against the last
 * ingested version recorded in `data/dataset-meta.json`, and — when changed
 * (or forced) — downloads the buildcrafting slice of tables.
 *
 * Only `X-API-Key` auth is used (no OAuth); that's all Phase 0 needs.
 */

import { readFile } from "node:fs/promises";

import {
  getDestinyManifest,
  getDestinyManifestSlice,
  type DestinyManifestSlice,
} from "bungie-api-ts/destiny2";
import type { HttpClient, HttpClientConfig } from "bungie-api-ts/http";

import { META_PATH } from "./paths";

/**
 * The buildcrafting slice: the only Manifest tables the ingestion needs.
 * `as const` preserves the literal names so the returned slice is precisely
 * typed to these 12 tables (and a wrong name is a compile error).
 */
export const MANIFEST_TABLES = [
  "DestinyInventoryItemDefinition",
  "DestinyPlugSetDefinition",
  "DestinySocketTypeDefinition",
  "DestinySocketCategoryDefinition",
  "DestinyStatDefinition",
  "DestinyStatGroupDefinition",
  "DestinyDamageTypeDefinition",
  "DestinySandboxPerkDefinition",
  "DestinyInventoryBucketDefinition",
  "DestinyItemCategoryDefinition",
  "DestinyEquipableItemSetDefinition",
  "DestinyArtifactDefinition",
] as const;

export type BuildcraftingTable = (typeof MANIFEST_TABLES)[number];
/** The typed shape of the fetched slice (only the 12 tables above). */
export type ManifestSlice = DestinyManifestSlice<BuildcraftingTable[]>;

const BUNGIE_ORIGIN = "https://www.bungie.net";

/**
 * Build an HttpClient over `fetch`. The Manifest metadata call requires the
 * API key; the CDN content JSON does not, but sending the header there is
 * harmless — so every request carries it.
 */
export function createBungieHttpClient(apiKey: string): HttpClient {
  return async <T>(config: HttpClientConfig): Promise<T> => {
    const url = new URL(config.url, BUNGIE_ORIGIN);
    if (config.params) {
      for (const [key, value] of Object.entries(config.params)) {
        if (value !== undefined && value !== null) {
          url.searchParams.append(key, String(value));
        }
      }
    }

    const response = await fetch(url, {
      method: config.method,
      headers: { "X-API-Key": apiKey },
      body: config.body === undefined ? undefined : JSON.stringify(config.body),
    });

    if (!response.ok) {
      throw new Error(
        `Bungie ${config.method} ${url.pathname} → ${response.status} ${response.statusText}`,
      );
    }
    return (await response.json()) as T;
  };
}

/** Read the manifest version from a prior ingest, or `null` if none exists. */
export async function readPreviousVersion(): Promise<string | null> {
  try {
    const raw = await readFile(META_PATH, "utf8");
    const meta = JSON.parse(raw) as { manifestVersion?: string };
    return meta.manifestVersion ?? null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export interface FetchManifestOptions {
  apiKey: string;
  /** Re-download even when the version is unchanged. */
  force?: boolean;
}

export interface FetchManifestResult {
  /** The live Manifest version string. */
  version: string;
  /** Whether the version differs from the last ingest. */
  changed: boolean;
  /** The downloaded slice, or `null` when unchanged and not forced. */
  slice: ManifestSlice | null;
}

/**
 * Fetch the Manifest version and, if it changed (or `force`), the table slice.
 * Returns `slice: null` to signal "nothing to do" so the orchestrator can skip.
 */
export async function fetchManifest(
  options: FetchManifestOptions,
): Promise<FetchManifestResult> {
  const http = createBungieHttpClient(options.apiKey);

  const manifestResponse = await getDestinyManifest(http);
  if (manifestResponse.ErrorCode !== 1) {
    throw new Error(
      `getDestinyManifest failed (${manifestResponse.ErrorStatus}): ${manifestResponse.Message}`,
    );
  }
  const manifest = manifestResponse.Response;
  const version = manifest.version;

  const previousVersion = await readPreviousVersion();
  const changed = version !== previousVersion;

  if (!changed && !options.force) {
    return { version, changed, slice: null };
  }

  const slice = await getDestinyManifestSlice(http, {
    destinyManifest: manifest,
    tableNames: [...MANIFEST_TABLES],
    language: "en",
  });

  return { version, changed, slice };
}
