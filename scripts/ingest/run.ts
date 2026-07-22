/**
 * Ingestion orchestrator — `pnpm ingest`.
 *
 * Fetches the Manifest (skipping when unchanged unless `--force`), classifies +
 * transforms the buildcrafting slice into derived entities, tags keywords,
 * builds inverted indexes, and emits the versioned dataset to `data/`.
 *
 * Requires `BUNGIE_API_KEY` in the environment (loaded from `.env.local` via
 * the package script, or passed inline: `BUNGIE_API_KEY=… pnpm ingest`).
 */

import { createClassifier } from "./classify";
import { emit } from "./emit";
import { fetchManifest } from "./fetchManifest";
import { buildIndexes } from "./indexes";
import { createKeywordTagger } from "./keywords";
import { transformAll } from "./transform";

async function main(): Promise<void> {
  const force = process.argv.includes("--force");

  const apiKey = process.env.BUNGIE_API_KEY;
  if (!apiKey) {
    console.error(
      "Missing BUNGIE_API_KEY. Copy .env.example to .env.local and set it, " +
        "or run: BUNGIE_API_KEY=… pnpm ingest",
    );
    process.exitCode = 1;
    return;
  }

  console.log("→ Fetching Manifest metadata…");
  const { version, changed, slice } = await fetchManifest({ apiKey, force });

  if (!slice) {
    console.log(
      `✓ Manifest unchanged (version ${version}); dataset is up to date. ` +
        "Use --force to re-ingest.",
    );
    return;
  }

  console.log(
    changed
      ? `→ Manifest changed → ${version}; ingesting…`
      : `→ Forcing re-ingest of version ${version}…`,
  );

  const classifier = createClassifier(slice);
  const tagger = createKeywordTagger();

  console.log("→ Transforming definitions into derived entities…");
  const result = transformAll(slice, classifier, tagger);

  console.log("→ Building inverted indexes…");
  const indexes = buildIndexes(result);

  console.log("→ Writing dataset to data/…");
  const meta = await emit({
    result,
    indexes,
    manifestVersion: version,
    ingestedAt: new Date().toISOString(),
  });

  console.log(`\n✓ Ingest complete (manifest ${meta.manifestVersion}). Counts:`);
  for (const [key, count] of Object.entries(meta.counts)) {
    console.log(`   ${key.padEnd(12)} ${count}`);
  }
}

main().catch((error) => {
  console.error("\n✗ Ingest failed:");
  console.error(error);
  process.exitCode = 1;
});
