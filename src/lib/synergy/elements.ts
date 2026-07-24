import type { Build, Hash, KeywordTags } from "@/lib/types";

import type { Lookup } from "@/lib/validation/types";

import type { BuildElement } from "./types";

/** Resolve a (partial) build into the tagged elements that drive synergy. */
export function collectBuildElements(build: Build, lookup: Lookup): BuildElement[] {
  const out: BuildElement[] = [];
  const seen = new Set<Hash>();
  const add = (hash: Hash, source: string, tags: KeywordTags) => {
    if (seen.has(hash)) return;
    seen.add(hash);
    out.push({ hash, source, tags });
  };

  for (const h of build.subclass.aspectHashes) {
    const a = lookup.aspect(h);
    if (a) add(a.hash, `aspect:${a.name}`, a.tags);
  }
  for (const h of build.subclass.fragmentHashes) {
    const f = lookup.fragment(h);
    if (f) add(f.hash, `fragment:${f.name}`, f.tags);
  }
  for (const w of build.weapons) {
    if (w.itemHash !== undefined) {
      const weapon = lookup.weapon(w.itemHash);
      if (weapon) add(weapon.hash, `weapon:${weapon.name}`, weapon.tags);
    }
    for (const c of w.perkConstraints) {
      // Resolve by hash first (future ingest may hash-tag plugs); otherwise fall
      // back to the plug-NAME bridge (v1: weapon plug hashes are disjoint from the
      // sandbox-perk namespace, so only the name resolves a tagged Perk).
      const p =
        (c.perkHash !== undefined ? lookup.perk(c.perkHash) : undefined) ??
        (c.perkName !== undefined ? lookup.perkByName(c.perkName) : undefined);
      if (p) add(p.hash, `perk:${p.name}`, p.tags);
    }
  }
  if (build.armor.exoticHash !== undefined) {
    const ar = lookup.armor(build.armor.exoticHash);
    if (ar) add(ar.hash, `armor:${ar.name}`, ar.tags);
  }
  for (const h of build.armor.modHashes) {
    const m = lookup.mod(h);
    if (m) add(m.hash, `mod:${m.name}`, m.tags);
  }
  for (const h of build.artifact.selectedPerkHashes) {
    const ap = lookup.artifactPerk(h);
    if (ap) add(ap.hash, `artifact-perk:${ap.name}`, ap.tags);
  }
  return out;
}
