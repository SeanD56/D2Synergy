/** Filesystem locations for the emitted dataset. Anchored to the repo root
 *  (pnpm runs scripts from the package root, so cwd is stable). */
import path from "node:path";

export const DATA_DIR = path.resolve(process.cwd(), "data");
export const META_PATH = path.join(DATA_DIR, "dataset-meta.json");
export const INDEXES_PATH = path.join(DATA_DIR, "indexes.json");
export const PLUG_TAGS_PATH = path.join(DATA_DIR, "plug-tags.json");
export const SOCKET_TYPES_PATH = path.join(DATA_DIR, "socket-types.json");
/** Hand-authored curated overlays (seed scaffold in Phase 0). */
export const CURATED_DIR = path.join(DATA_DIR, "curated");
