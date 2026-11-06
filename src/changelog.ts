import text from "../CHANGELOG.md?raw";

export interface Release {
  version: string;
  notes: string;
}

/** Splits a changelog into its `## version` sections, newest first as written. */
export function parseChangelog(source: string): Release[] {
  return source
    .split(/^## /m)
    .slice(1)
    .map((section) => {
      const end = section.indexOf("\n");
      return { version: section.slice(0, end).trim(), notes: section.slice(end + 1).trim() };
    });
}

const parts = (version: string) => version.split(".").map((n) => parseInt(n, 10) || 0);

/** Above zero when `a` is the newer version. */
export function compareVersions(a: string, b: string) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return 0;
}

/**
 * The releases to tell someone about, having last seen `seen`. Someone with no
 * record of that hears about the version they're on, as older notes are old news.
 */
export function unseenReleases(releases: Release[], current: string, seen: string | null) {
  return releases.filter((r) =>
    seen === null
      ? compareVersions(r.version, current) === 0
      : compareVersions(r.version, seen) > 0 && compareVersions(r.version, current) <= 0,
  );
}

export const RELEASES = parseChangelog(text);
