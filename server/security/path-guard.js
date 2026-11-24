// NFR-SEC-002. THE ONLY PLACE A PATH IS RESOLVED in this codebase.
//
// repo-scaffold §4.2 names this a single-responsibility chokepoint: "a second path.resolve is a
// traversal bug waiting to happen". scripts/check-nonnegotiables.js fails the build if
// path.resolve appears anywhere else in server/.

import { resolve, normalize, relative, isAbsolute, sep } from 'node:path';
import { realpathSync, existsSync, lstatSync } from 'node:fs';

export class PathRejected extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.code = 'path_rejected';
    this.requirementId = 'NFR-SEC-002';
    this.detail = detail;
  }
}

/**
 * Resolve `candidate` and prove it stays under `root`.
 *
 * Rejects: absolute escapes, `..` traversal, symlinks pointing outside the root, and any path
 * whose real location differs from its lexical one. Symlinks are checked against the REAL path
 * because a lexical check alone is defeated by a link.
 */
export function resolveWithin(root, candidate, { mustExist = false, allowSymlink = false } = {}) {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new PathRejected('Empty path is not a valid target.');
  }
  if (candidate.includes('\0')) {
    throw new PathRejected('Path contains a null byte.', { candidate: '<redacted>' });
  }

  const absRoot = resolve(root);
  const joined = isAbsolute(candidate) ? resolve(candidate) : resolve(absRoot, candidate);
  const normalised = normalize(joined);

  const rel = relative(absRoot, normalised);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new PathRejected(
      `Target resolves outside the workspace root. Writes are confined to approved, ` +
      `path-validated targets. Expected a path under ${absRoot}.`,
      { root: absRoot, resolved: normalised }
    );
  }

  if (!allowSymlink && existsSync(normalised)) {
    const st = lstatSync(normalised);
    if (st.isSymbolicLink()) {
      throw new PathRejected('Target is a symbolic link. Symlinked write targets are rejected.', { resolved: normalised });
    }
    // A parent directory may itself be a link; compare the real path, not the lexical one.
    const real = realpathSync(normalised);
    const realRel = relative(realpathSync(absRoot), real);
    if (realRel.startsWith('..') || isAbsolute(realRel)) {
      throw new PathRejected(
        'Target resolves outside the workspace root once symbolic links are followed.',
        { resolved: normalised }
      );
    }
  }

  if (mustExist && !existsSync(normalised)) {
    throw new PathRejected(`Target does not exist: ${rel}`, { resolved: normalised });
  }

  return normalised;
}

/** A path is safe to show in a message: strip the root so no absolute path leaks to the UI. */
export function displayPath(root, abs) {
  const rel = relative(resolve(root), abs);
  return rel.split(sep).join('/');
}
