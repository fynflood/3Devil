/**
 * Pixel art for the screensaver, as rows of palette keys; "." is empty. The
 * wizard and the dragon's head face right and are mirrored to face left.
 */

export const WIZARD_PALETTE: Record<string, string> = {
  K: "#0a080c", // outline, the dark inside the hood
  c: "#2a2530", // robe
  C: "#3d3645", // robe, lit
  d: "#1c1920", // robe, shade
  r: "#5a1618", // crimson rags
  E: "#a6ff5e", // eyes
  b: "#cdc3aa", // bone
  B: "#8c826b", // bone, shade
  g: "#a6ff5e", // the skull's eyes
  w: "#3b2b20", // staff
};

/** The necromancer without the staff, which is drawn on top so it can be raised. */
export const WIZARD = [
  "....KKK......",
  "...KcCcK.....",
  "..KcCCccK....",
  ".KccCcKKcK...",
  ".KcCcKEKEK...",
  ".KcccKKKKK...",
  ".KcccKKKKcK..",
  "KccccKKKcrK..",
  "KcccccccrrK..",
  "KccCccccrcKK.",
  "KccCcccccrccK",
  "KcCCccccccrcK",
  ".KcCccccccccK",
  ".KcCcccccccrK",
  ".KcCccccccccK",
  ".KcCccccccccK",
  ".KcCcccccdccK",
  "KccCccccdcccK",
  "KccCcccdccccK",
  "KcCCccddccccK",
  "KcCccdddcccrK",
  "KcCcddcdccrrK",
  "KcCddcddcrrrK",
  "KrcdKcddKcrrK",
  "KrKdK.KdK.KrK",
  ".K.K...K...K.",
];

/** The staff with its skull and the bony hand holding it, drawn at column 11. */
export const STAFF = [
  ".bbb.",
  "bgbgb",
  "bbbbb",
  ".bBb.",
  "..w..",
  "..w..",
  "..w..",
  "..w..",
  "bbw..",
  ".bw..",
  "..w..",
  "..w..",
  "..w..",
  "..w..",
  "..w..",
  "..w..",
  "..w..",
  "..w..",
  "..w..",
  "..w..",
  "..w..",
  "..w..",
  "..w..",
  "..w..",
  "..w..",
  "..w..",
];

/**
 * The dragon's head, in the materials its body is drawn with: 1 scales,
 * 2 underside, 4 bone, 5 eye, 6 fire in the mouth, k dark. The neck joins at
 * column 3, row 8.
 */
export const DRAGON_HEAD = [
  "4...............................",
  ".44.............................",
  "..444...........................",
  "...4444.........................",
  "....11444.......................",
  "...11111144.....................",
  "..111111111111..................",
  ".1111111kk5511111...............",
  ".111111111kk11111111111.........",
  ".11111111111111111111111111k1...",
  ".1111111111111111111111111111...",
  ".11111114k4kk4kk4kk4kk4k44411...",
  "..11222222222222222222222241....",
  "...12222222222222222222221......",
  "....1111222222222222221.........",
  "......11111111111111............",
];

export const DRAGON_HEAD_OPEN = [
  "4...............................",
  ".44.............................",
  "..444...........................",
  "...4444.........................",
  "....11444.......................",
  "...11111144.....................",
  "..111111111111..................",
  ".1111111kk5511111...............",
  ".111111111kk11111111111.........",
  ".11111111111111111111111111k1...",
  ".1111111111111111111111111111...",
  ".1111114.4..4..4..4..4.44411....",
  ".11166666666666666666666661.....",
  "..11666666666666666666666.......",
  "..1126666666666666666666........",
  "...12226666666666666664.........",
  "...1222224.4..4..4..4.4.........",
  "....1222222222222222222.........",
  ".....11222222222222221..........",
  ".......111111111111.............",
];

/** Where fire leaves the open mouth, in head pixels. */
export const MOUTH = { x: 22, y: 14 };
