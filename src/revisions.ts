import type { Part } from "./types";

/** Words publishers put in a file or folder name to say it's a newer version. */
const REVISION_WORDS = new Set([
  "rev", "revs", "revised", "revision", "revisions", "update", "updated",
  "fix", "fixed", "fixes", "patch", "patched", "corrected",
]);

const isNumber = (word: string) => /^\d+$/.test(word);

/** A revision word with its number run on, as in rev1, revised5, r10 or v2. */
const RUN_ON = new RegExp(`^(${[...REVISION_WORDS, "r", "v"].join("|")})(\\d+)$`);

function splitWords(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    // Copy counts, as in quantityFromName.
    .replace(/(^|[\s_\-(])(x\d{1,3}|\d{1,3}x)(?=$|[\s_\-)])/gi, " ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .flatMap((word) => RUN_ON.exec(word)?.slice(1) ?? [word]);
}

/**
 * A name's words without its revision marks and the numbers after them, which
 * are revisions or dates: Corner_Stairs_Rev_11526, door_rev1_18_22, r10-6-22, v2.
 */
function parseName(name: string): { words: string[]; revised: boolean } {
  const all = splitWords(name);
  const words: string[] = [];
  let revised = false;
  for (let i = 0; i < all.length; i++) {
    const word = all[i];
    let end = i + 1;
    while (end < all.length && isNumber(all[end])) end++;
    const numbers = end - i - 1;
    const version = (word === "v" || word === "version") && numbers > 0;
    // "r" alone is usually "right", as in Wall_R_1, so it has to come with a date.
    const dated = word === "r" && (numbers >= 3 || (numbers >= 1 && all[i + 1].length >= 5));
    if (REVISION_WORDS.has(word) || version || dated) {
      revised = true;
      i = end - 1;
    } else {
      words.push(word.length > 3 ? word.replace(/s$/, "") : word);
    }
  }
  return { words, revised };
}

/** How alike two names are: an exact match, or one with a few extra words. 0 if neither. */
function similarity(a: string[], b: string[]): number {
  if (a.join(" ") === b.join(" ")) return 100;
  const [small, large] = a.length < b.length ? [a, b] : [b, a];
  const extra = large.filter((w) => !small.includes(w));
  if (small.length < 2 || !small.every((w) => large.includes(w))) return 0;
  // Numbers tell parts apart: Wall_1 is no revision of Wall_1_2.
  if (extra.length > 2 || extra.some(isNumber)) return 0;
  return 50 - extra.length * 10;
}

function sharedFolders(a: Part, b: Part): number {
  const [x, y] = [a.group.split("/"), b.group.split("/")];
  let n = 0;
  while (n < x.length && x[n] === y[n]) n++;
  return n;
}

/**
 * Likely newer versions among a project's new parts: each part's id with the
 * older parts it may replace, best match first. A new part needs a revision
 * mark in its name or folder, since a matching name alone is often an
 * alternative, such as roof_1 in a "Hollowed out Roof Option" folder.
 */
export function findRevisions(parts: Part[]): Map<string, Part[]> {
  const found = new Map<string, Part[]>();
  const fresh = parts.filter((p) => p.update === "new" && !p.replaces && !p.notRevision);
  if (!fresh.length) return found;
  const older = parts
    .filter((p) => p.update !== "new" && !p.replacedBy)
    .map((part) => ({ part, words: parseName(part.name).words }));
  for (const part of fresh) {
    const { words, revised } = parseName(part.name);
    if (!words.length || !(revised || part.group.split("/").some((g) => parseName(g).revised))) continue;
    const matches = older
      .map((o) => ({ part: o.part, score: similarity(words, o.words) }))
      .filter((m) => m.score > 0)
      .map((m) => ({ ...m, score: m.score + sharedFolders(part, m.part) }))
      .sort((a, b) => b.score - a.score);
    if (matches.length) found.set(part.id, matches.map((m) => m.part));
  }
  return found;
}
