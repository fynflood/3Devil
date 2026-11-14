import { useEffect, useRef, useState } from "react";
import { DRAGON_HEAD, DRAGON_HEAD_OPEN, MOUTH, STAFF, WIZARD, WIZARD_PALETTE } from "../screensaverSprites";

/** Minutes idle before it starts, unless changed in Settings. */
export const DEFAULT_SCREENSAVER = 3;

type Ctx = CanvasRenderingContext2D;

interface Vec {
  x: number;
  y: number;
}

/** The top edge of something on screen, in scene pixels. */
interface Ledge {
  x0: number;
  x1: number;
  y: number;
}

interface Size {
  /** Screen pixels to one scene pixel. */
  scale: number;
  w: number;
  h: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const between = (a: Vec, b: Vec, t: number): Vec => ({ x: mix(a.x, b.x, t), y: mix(a.y, b.y, t) });
const gap = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

// ── Terrain ──────────────────────────────────────────────────────────────

const PICTURES = new Set(["IMG", "CANVAS", "VIDEO"]);
const HEADINGS = new Set(["H1", "H2", "H3"]);
const clear = (color: string) => color === "transparent" || /[,/]\s*0\)$/.test(color);

/** Whether the element has a top edge you can see: a border, or a fill unlike what's behind it. */
function edged(el: Element) {
  if (PICTURES.has(el.tagName)) return true;
  const style = getComputedStyle(el);
  if (parseFloat(style.borderTopWidth) > 0 && !clear(style.borderTopColor)) return true;
  if (clear(style.backgroundColor)) return style.backgroundImage !== "none";
  for (let up = el.parentElement; up; up = up.parentElement) {
    const behind = getComputedStyle(up).backgroundColor;
    if (!clear(behind)) return behind !== style.backgroundColor;
  }
  return true;
}

/** Where a heading's words are, with the top at the top of its capitals. */
function words(el: Element) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const r = range.getBoundingClientRect();
  const font = parseFloat(getComputedStyle(el).fontSize);
  return new DOMRect(r.left, r.top + (r.height - font) / 2 + font * 0.2, r.width, r.height);
}

/** The ledges the fight happens on: the tops of what's on screen, and the bottom of the window. */
function ledges({ scale, w }: Size): Ledge[] {
  const found: Ledge[] = [];
  for (const el of document.querySelectorAll("body *")) {
    if (el.closest(".screensaver")) continue;
    const heading = HEADINGS.has(el.tagName);
    const r = heading ? words(el) : el.getBoundingClientRect();
    if (r.width < 40 || r.height < 10 || r.top < 8 || r.top > window.innerHeight - 8) continue;
    if (r.right < 0 || r.left > window.innerWidth) continue;
    if (!heading && !edged(el)) continue;
    // Not what's covered by something else, like the page behind a dialog.
    const top = document.elementsFromPoint(r.left + r.width / 2, r.top + 2).find((e) => !e.closest(".screensaver"));
    if (!top || !(el === top || el.contains(top))) continue;
    found.push({ x0: Math.max(0, r.left / scale), x1: Math.min(w, r.right / scale), y: Math.round(r.top / scale) });
  }
  const merged: Ledge[] = [];
  for (const l of found.sort((a, b) => a.y - b.y || a.x0 - b.x0)) {
    const same = merged.find((m) => Math.abs(m.y - l.y) <= 2 && l.x0 <= m.x1 + 1 && l.x1 >= m.x0 - 1);
    if (same) {
      same.x0 = Math.min(same.x0, l.x0);
      same.x1 = Math.max(same.x1, l.x1);
    } else merged.push(l);
  }
  merged.push({ x0: 0, x1: w, y: Math.floor(window.innerHeight / scale) });
  return merged;
}

// ── Drawing in whole pixels ──────────────────────────────────────────────

function disc(ctx: Ctx, cx: number, cy: number, r: number) {
  const x = Math.round(cx);
  const y = Math.round(cy);
  for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
    const half = r * r - dy * dy;
    if (half < 0) continue;
    const reach = Math.round(Math.sqrt(half));
    ctx.fillRect(x - reach, y + dy, 2 * reach + 1, 1);
  }
}

/** A line `r` thick on each side; 0 is a single pixel wide. */
function stroke(ctx: Ctx, a: Vec, b: Vec, r: number) {
  const n = Math.max(1, Math.ceil(gap(a, b)));
  for (let i = 0; i <= n; i++) {
    const p = between(a, b, i / n);
    if (r < 1) ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
    else disc(ctx, p.x, p.y, r);
  }
}

/** Fills between the outlines given, so an outline inside another is a hole in it. */
function fill(ctx: Ctx, outlines: Vec[][]) {
  const ys = outlines.flat().map((p) => p.y);
  for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
    const at = y + 0.5;
    const xs: number[] = [];
    for (const o of outlines)
      o.forEach((a, i) => {
        const b = o[(i + 1) % o.length];
        if (a.y <= at !== b.y <= at) xs.push(a.x + ((at - a.y) / (b.y - a.y)) * (b.x - a.x));
      });
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = Math.round(xs[i]);
      const x1 = Math.round(xs[i + 1]);
      if (x1 > x0) ctx.fillRect(x0, y, x1 - x0, 1);
    }
  }
}

/**
 * Draws pixel art with its `pivot` at `at`, turned by `angle`, mirrored when
 * `facing` is -1 and `zoom` times the size. Below 1, `density` leaves pixels
 * out at random.
 */
function blit(ctx: Ctx, rows: string[], colors: Record<string, string>, at: Vec, pivot: Vec, angle: number, facing: number, density = 1, zoom = 1) {
  const reach = Math.ceil(Math.hypot(Math.max(pivot.x, rows[0].length - pivot.x), Math.max(pivot.y, rows.length - pivot.y)) * zoom);
  const cos = Math.cos(angle) / zoom;
  const sin = Math.sin(angle) / zoom;
  const ox = Math.round(at.x);
  const oy = Math.round(at.y);
  for (let dy = -reach; dy <= reach; dy++)
    for (let dx = -reach; dx <= reach; dx++) {
      const lx = dx * facing;
      const key = rows[Math.round(pivot.y - lx * sin + dy * cos)]?.[Math.round(pivot.x + lx * cos + dy * sin)];
      if (!key || key === "." || (density < 1 && Math.random() > density)) continue;
      ctx.fillStyle = colors[key];
      ctx.fillRect(ox + dx, oy + dy, 1, 1);
    }
}

// ── The dragon ───────────────────────────────────────────────────────────

/** What the dragon is made of; the head's art uses the same keys. */
const HIDE: Record<string, string> = {
  "1": "#120d11", // scales
  "2": "#43241f", // underside
  "4": "#c9bda4", // bone
  "5": "#ff3b1c", // eye
  "6": "#ff8a2a", // fire in the mouth
  "7": "#541519", // wing
  "8": "#2a0b0e", // the far wing
  k: "#050305",
};
/** Lit from inside while it breathes fire. */
const HOT = { ...HIDE, "2": "#b04a1a", "7": "#742016" };
/** The flash when a bolt lands. */
const STRUCK = Object.fromEntries(Object.keys(HIDE).map((k) => [k, "#efffe0"]));
/** A thin edge around both of them, so they read against a dark window. */
const RIM = "#6e2219";

/** How big it is; its parts below are measured for a dragon of size 1. */
const BULK = 1.35;
const TAIL = 18;
const LINK = 3.5 * BULK;
const NECK = 24 * BULK;
/** Where the head's art joins the neck. */
const SKULL: Vec = { x: 3, y: 8 };

/** A wing, raised, from its root: x backwards along the body, y up. */
const WRIST: Vec = { x: 8, y: -26 };
const FINGERS: Vec[] = [
  { x: -4, y: -52 },
  { x: -29, y: -45 },
  { x: -50, y: -28 },
  { x: -56, y: -5 },
  { x: -14, y: 4 },
];
/** How the skin sags and tears between fingers: how far along, and how far in toward the wrist. */
const TEARS = [
  [[0.3, 0.24], [0.5, 0.4], [0.7, 0.2]],
  [[0.2, 0.3], [0.35, 0.16], [0.5, 0.5], [0.65, 0.28], [0.8, 0.38]],
  [[0.3, 0.3], [0.5, 0.44], [0.6, 0.2], [0.8, 0.34]],
  [[0.3, 0.36], [0.6, 0.52], [0.8, 0.3]],
];
/** Holes, as a finger and how far along it. */
const HOLES = [
  [1, 0.62],
  [2, 0.8],
  [3, 0.55],
];

/** Hip or shoulder, knee, foot, for the hind leg and the fore: standing, and tucked up in flight. */
const STANDING = [
  [[-9, 5], [-15, 9], [-8, 12]],
  [[9, 4], [13, 9], [10, 12]],
];
const TUCKED = [
  [[-9, 5], [-16, 10], [-23, 9]],
  [[9, 4], [13, 10], [8, 13]],
];
/** How far above a ledge its middle is when it stands there. */
const STANCE = Math.round(12 * BULK) + 3;

interface Dragon {
  at: Vec;
  vel: Vec;
  goal: Vec;
  speed: number;
  facing: number;
  perched: boolean;
  /** Where the wingbeat is, in radians. */
  flap: number;
  /** How raised and how spread the wings are when it isn't flying. */
  lift: number;
  reach: number;
  rear: boolean;
  /** The head's angle from straight ahead, down being positive; `look` fixes it, or null follows the wizard. */
  aim: number;
  look: number | null;
  jaw: boolean;
  fire: boolean;
  /** Seconds left of the flash and of the scream after a bolt lands. */
  hurt: number;
  cry: number;
  body: Vec;
  head: Vec;
  mouth: Vec;
  tail: Vec[];
}

function wing(ctx: Ctx, root: Vec, facing: number, lift: number, reach: number, skin: string, bone: string, claw: string) {
  const to = (p: Vec): Vec => ({ x: root.x + facing * p.x * reach * BULK, y: root.y + p.y * lift * BULK });
  const wrist = to(WRIST);
  const tips = FINGERS.map(to);
  const edge: Vec[] = [];
  tips.forEach((tip, i) => {
    edge.push(tip);
    for (const [along, sag] of TEARS[i] ?? []) edge.push(between(between(tip, tips[i + 1], along), wrist, sag));
  });
  const holes =
    Math.abs(lift) < 0.5
      ? []
      : HOLES.map(([finger, along]) => {
          const c = between(wrist, between(tips[finger], tips[finger + 1], 0.45), along);
          return [
            { x: c.x - 2, y: c.y - 1 },
            { x: c.x + 1, y: c.y - 2 },
            { x: c.x + 2, y: c.y + 2 },
            { x: c.x - 1, y: c.y + 1 },
          ];
        });
  ctx.fillStyle = skin;
  fill(ctx, [[root, wrist, ...edge], ...holes]);
  ctx.fillStyle = bone;
  stroke(ctx, root, wrist, 1.5 * BULK);
  for (const tip of tips.slice(0, 4)) stroke(ctx, wrist, tip, 0);
  ctx.fillStyle = claw;
  ctx.fillRect(Math.round(wrist.x + facing), Math.round(wrist.y) - 3, 1, 3);
  for (const tip of tips.slice(0, 4)) ctx.fillRect(Math.round(tip.x), Math.round(tip.y), 1, 1);
}

function legs(ctx: Ctx, d: Dragon, shift: number, hide: string, claw: string) {
  const local = ([x, y]: number[]): Vec => ({ x: d.body.x + d.facing * (x + shift) * BULK, y: d.body.y + y * BULK });
  for (const [top, knee, foot] of d.perched ? STANDING : TUCKED) {
    ctx.fillStyle = hide;
    stroke(ctx, local(top), local(knee), 2.5 * BULK);
    stroke(ctx, local(knee), local(foot), 1.5 * BULK);
    ctx.fillStyle = claw;
    const { x, y } = local(foot);
    for (const toe of [-2, 0, 2]) ctx.fillRect(Math.round(x) + toe, Math.round(y) + 1, 1, 2);
  }
}

function drawDragon(ctx: Ctx, d: Dragon, skin: Record<string, string>) {
  const f = d.facing;
  const local = (x: number, y: number): Vec => ({ x: d.body.x + f * x * BULK, y: d.body.y + y * BULK });
  const lift = d.perched ? d.lift : Math.cos(d.flap) * 0.85 + 0.15;
  const far = d.perched ? d.lift * 0.9 : Math.cos(d.flap - 0.6) * 0.85 + 0.15;

  wing(ctx, local(0, -8), f, far, d.reach, skin["8"], skin.k, skin.k);
  legs(ctx, d, 3, skin.k, skin.k);

  // The spine from the tip of the tail to the back of the skull.
  const hip = local(-12, 1);
  const shoulder = local(12, -3);
  const arch = { x: shoulder.x + f * 3 * BULK, y: shoulder.y - 15 * BULK };
  const spine: { at: Vec; r: number; belly: boolean; up: Vec }[] = [];
  const joint = (at: Vec, r: number, belly: boolean) => spine.push({ at, r: r * BULK, belly, up: { x: 0, y: -1 } });
  for (let i = TAIL - 1; i >= 1; i--) joint(d.tail[i], 0.8 + 6 * (1 - i / TAIL), i < 6);
  for (let i = 0; i <= 6; i++) joint(between(hip, shoulder, i / 6), 7 + 4 * Math.sin((Math.PI * i) / 6), true);
  for (let i = 1; i <= 9; i++) {
    const t = i / 9;
    joint(between(between(shoulder, arch, t), between(arch, d.head, t), t), mix(7, 4.5, t), true);
  }
  spine.forEach((j, i) => {
    const a = (spine[i - 1] ?? j).at;
    const b = (spine[i + 1] ?? j).at;
    const len = gap(a, b) || 1;
    j.up = { x: (f * (b.y - a.y)) / len, y: (-f * (b.x - a.x)) / len };
  });

  ctx.fillStyle = skin["4"];
  spine.forEach((j, i) => {
    if (i % 2 === 0) stroke(ctx, j.at, { x: j.at.x + j.up.x * (j.r + 3), y: j.at.y + j.up.y * (j.r + 3) }, 0);
  });
  const tip = d.tail[TAIL - 1];
  const back = between(d.tail[TAIL - 2], tip, 2.6);
  const out = spine[0].up;
  fill(ctx, [[back, { x: tip.x + out.x * 4, y: tip.y + out.y * 4 }, { x: tip.x - out.x * 4, y: tip.y - out.y * 4 }]]);
  ctx.fillStyle = skin["1"];
  for (const j of spine) disc(ctx, j.at.x, j.at.y, j.r);
  ctx.fillStyle = skin["2"];
  for (const j of spine) if (j.belly) disc(ctx, j.at.x - j.up.x * j.r * 0.55, j.at.y - j.up.y * j.r * 0.55, j.r * 0.4);

  legs(ctx, d, 0, skin["1"], skin["4"]);
  blit(ctx, d.jaw || d.cry > 0 ? DRAGON_HEAD_OPEN : DRAGON_HEAD, skin, d.head, SKULL, d.aim, f, 1, BULK);
  wing(ctx, local(5, -7), f, lift, d.reach, skin["7"], skin["1"], skin["4"]);
}

// ── The wizard ───────────────────────────────────────────────────────────

/** The skull's eyes flare while he casts. */
const CASTING = { ...WIZARD_PALETTE, g: "#f1ffe0" };
const SOUL = "#a6ff5e";
/** How far from the middle of his ledge spot the ward's centre is, and how wide it reaches. */
const CHEST = 13;
const WARD = 17;

interface Wizard {
  /** The middle of his feet. */
  at: Vec;
  facing: number;
  /** How much of him is there, 0 to 1, and which way that's going. */
  here: number;
  shown: boolean;
  casting: boolean;
  ward: number;
  warding: boolean;
}

function drawWizard(ctx: Ctx, w: Wizard) {
  if (w.here <= 0) return;
  const raise = w.casting ? 3 : 0;
  blit(ctx, WIZARD, WIZARD_PALETTE, w.at, { x: 6, y: WIZARD.length }, 0, w.facing, w.here);
  blit(ctx, STAFF, w.casting ? CASTING : WIZARD_PALETTE, w.at, { x: -3, y: STAFF.length + raise }, 0, w.facing, w.here);
}

// ── The fight ────────────────────────────────────────────────────────────

interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  kind: "fire" | "smoke" | "soul" | "blood";
}

/** Something left on a ledge: fire that burns for `burn` seconds then glows, or blood that runs `drip` pixels down. */
interface Mark {
  x: number;
  y: number;
  age: number;
  life: number;
  burn: number;
  drip: number;
}

interface Bolt {
  at: Vec;
  vel: Vec;
  /** Whether it follows the dragon. */
  sure: boolean;
  age: number;
}

function tint(m: Mote) {
  if (m.kind === "fire") return m.age < 0.12 ? "#fff1b0" : m.age < 0.35 ? "#ffb436" : m.age < 0.7 ? "#f2601c" : "#8f2410";
  if (m.kind === "smoke") return "#5d5559";
  if (m.kind === "blood") return "#8e0f14";
  return Math.random() < 0.3 ? "#f1ffe0" : SOUL;
}

/** Runs the fight on a canvas until unmounted. */
function useFight(canvas: React.RefObject<HTMLCanvasElement | null>, size: Size) {
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    const { w, h } = size;
    const terrain = ledges(size);
    // The two of them are drawn apart from the rest, to put an edge around them.
    const figures = document.createElement("canvas");
    const edges = document.createElement("canvas");
    figures.width = edges.width = w;
    figures.height = edges.height = h;
    const layer = figures.getContext("2d")!;
    const rim = edges.getContext("2d")!;

    const wizard: Wizard = { at: { x: w / 2, y: h }, facing: 1, here: 0, shown: false, casting: false, ward: 0, warding: false };
    const dragon: Dragon = {
      at: { x: -80, y: -50 },
      vel: { x: 0, y: 0 },
      goal: { x: -80, y: -50 },
      speed: 150,
      facing: 1,
      perched: false,
      flap: 0,
      lift: 0.45,
      reach: 0.7,
      rear: false,
      aim: 0,
      look: null,
      jaw: false,
      fire: false,
      hurt: 0,
      cry: 0,
      body: { x: 0, y: 0 },
      head: { x: 0, y: 0 },
      mouth: { x: 0, y: 0 },
      tail: [],
    };
    let motes: Mote[] = [];
    let bolts: Bolt[] = [];
    const marks = new Map<string, Mark>();
    let time = 0;
    let flames = 0;

    const mote = (kind: Mote["kind"], x: number, y: number, vx: number, vy: number, life: number) =>
      motes.push({ x, y, vx, vy, age: 0, life, kind });
    const burst = (kind: Mote["kind"], n: number, at: Vec, speed: number, life: number) => {
      for (let i = 0; i < n; i++) {
        const a = rand(0, Math.PI * 2);
        const v = rand(speed / 4, speed);
        mote(kind, at.x, at.y, Math.cos(a) * v, Math.sin(a) * v, rand(life / 2, life));
      }
    };
    const skull = (): Vec => ({ x: wizard.at.x + wizard.facing * 5, y: wizard.at.y - STAFF.length - (wizard.casting ? 2 : -1) });
    const chest = (): Vec => ({ x: wizard.at.x, y: wizard.at.y - CHEST });

    /** Somewhere for the wizard to stand, away from where he is. */
    const stand = (): Vec => {
      const room = terrain.filter((l) => l.x1 - l.x0 >= 18 && l.y >= WIZARD.length + 6);
      const low = room.filter((l) => l.y >= 64);
      const spots = low.length > 1 ? low : room;
      for (let tries = 0; ; tries++) {
        const l = spots[Math.floor(rand(0, spots.length))];
        const at = { x: Math.round(rand(l.x0 + 8, l.x1 - 8)), y: l.y };
        if (tries > 12 || gap(at, wizard.at) > 70) return at;
      }
    };

    /** A ledge for the dragon within reach of the wizard, if there is one. */
    const roost = (): Vec | null => {
      let best: Vec | null = null;
      let least = 150;
      for (const l of terrain) {
        if (l.x1 - l.x0 < 34 || l.y < 40) continue;
        for (const side of [-1, 1]) {
          const x = clamp(wizard.at.x + side * 125, l.x0 + 16, l.x1 - 16);
          const away = Math.abs(x - wizard.at.x);
          if (away < 75) continue;
          // Better a ledge where all of it is in the window.
          const cramped = x < 55 || x > w - 55 ? 60 : 0;
          const score = Math.abs(away - 125) + Math.abs(l.y - wizard.at.y) * 0.6 + cramped + rand(0, 40);
          if (score >= least) continue;
          best = { x, y: l.y - STANCE };
          least = score;
        }
      }
      return best;
    };
    const hover = (): Vec => {
      const side = wizard.at.x > w / 2 ? -1 : 1;
      return { x: wizard.at.x + side * 125, y: clamp(wizard.at.y - 55, 40, h - 30) };
    };
    const arrived = () => gap(dragon.at, dragon.goal) < 4;

    function* blink() {
      wizard.shown = false;
      yield () => wizard.here <= 0;
      wizard.at = stand();
      wizard.shown = true;
      yield () => wizard.here >= 1;
    }

    /** Throws a bolt; one that isn't sure flies straight, and the dragon may get out of its way. */
    function* cast(sure: boolean) {
      wizard.casting = true;
      yield 0.7;
      const from = skull();
      const far = gap(from, dragon.body) || 1;
      bolts.push({ at: from, vel: { x: ((dragon.body.x - from.x) / far) * 170, y: ((dragon.body.y - from.y) / far) * 170 }, sure, age: 0 });
      yield 0.3;
      wizard.casting = false;
      if (!sure) {
        yield () => !bolts.length || gap(bolts[0].at, dragon.body) < 75;
        if (bolts.length && !dragon.perched) {
          dragon.goal = { x: dragon.at.x + dragon.facing * 30, y: dragon.at.y + (dragon.at.y > 70 ? -55 : 55) };
          dragon.speed = 240;
        }
      }
      yield () => !bolts.length;
      dragon.speed = 150;
    }

    /** The fight, as waits: a number of seconds, or something to become true. */
    function* show(): Generator<number | (() => boolean), never, void> {
      wizard.at = stand();
      wizard.shown = true;
      dragon.at = { x: wizard.at.x < w / 2 ? w + 80 : -80, y: -50 };
      dragon.tail = Array.from({ length: TAIL }, () => ({ ...dragon.at }));
      yield 1.5;
      for (;;) {
        // It comes down near him, roars, and burns him; his ward turns the fire.
        const perch = roost();
        dragon.perched = false;
        dragon.goal = perch ?? hover();
        yield arrived;
        if (perch) {
          dragon.perched = true;
          dragon.at = { ...perch };
          dragon.vel = { x: 0, y: 0 };
          burst("smoke", 10, { x: perch.x, y: perch.y + STANCE - 1 }, 18, 0.8);
        }
        yield 0.7;
        dragon.rear = dragon.jaw = true;
        dragon.look = -0.75;
        yield 1;
        wizard.warding = true;
        dragon.look = null;
        yield 0.3;
        dragon.fire = true;
        yield 1.8;
        dragon.fire = dragon.jaw = dragon.rear = false;
        yield 0.8;
        wizard.warding = false;

        // His answer draws blood.
        yield* cast(true);

        // It takes off and rakes his ledge with fire; he is gone before it lands.
        const side = dragon.at.x < wizard.at.x ? 1 : -1;
        const height = Math.max(40, wizard.at.y - 74);
        dragon.perched = false;
        dragon.goal = { x: wizard.at.x - side * 140, y: height };
        yield arrived;
        dragon.goal = { x: wizard.at.x + side * 120, y: height + 4 };
        dragon.speed = 115;
        dragon.look = 0.95;
        dragon.jaw = dragon.fire = true;
        yield () => (wizard.at.x - dragon.at.x) * side < 85;
        yield* blink();
        yield arrived;
        dragon.fire = dragon.jaw = false;
        dragon.look = null;
        dragon.speed = 150;

        // From his new ledge he tries again, and sometimes it sees the bolt coming.
        yield* cast(Math.random() < 0.6);
        yield 1;
      }
    }
    const script = show();
    let wait = script.next().value;
    let waited = 0;

    const moveDragon = (dt: number) => {
      const d = dragon;
      if (d.perched) {
        d.facing = wizard.at.x < d.at.x ? -1 : 1;
        d.lift += ((d.rear ? 1 : 0.45) - d.lift) * Math.min(1, dt * 6);
        d.reach += ((d.rear ? 1 : 0.7) - d.reach) * Math.min(1, dt * 6);
      } else {
        const far = gap(d.goal, d.at) || 1;
        const want = Math.min(d.speed, far * 2.5);
        const pull = Math.min(1, dt * 3);
        d.vel.x += (((d.goal.x - d.at.x) / far) * want - d.vel.x) * pull;
        d.vel.y += (((d.goal.y - d.at.y) / far) * want - d.vel.y) * pull;
        d.at.x += d.vel.x * dt;
        d.at.y += d.vel.y * dt;
        d.flap += dt * 9;
        d.reach = 1;
        d.facing = Math.abs(d.vel.x) > 14 ? Math.sign(d.vel.x) : wizard.at.x < d.at.x ? -1 : 1;
      }
      const f = d.facing;
      // In the air the body rises as the wings come down.
      d.body = { x: d.at.x, y: d.at.y + (d.perched ? 0 : Math.cos(d.flap) * 3) };

      const shoulder = { x: d.body.x + f * 12 * BULK, y: d.body.y - 3 * BULK };
      const target = chest();
      const want = d.look ?? clamp(Math.atan2(target.y - (shoulder.y - 14 * BULK), (target.x - shoulder.x) * f), -1.1, 1.1);
      d.aim += (want - d.aim) * Math.min(1, dt * 7);
      const neck = -0.6 + d.aim * 0.55;
      d.head = { x: shoulder.x + f * Math.cos(neck) * NECK, y: shoulder.y + Math.sin(neck) * NECK };
      const mx = (MOUTH.x - SKULL.x) * BULK;
      const my = (MOUTH.y - SKULL.y) * BULK;
      d.mouth = {
        x: d.head.x + f * (mx * Math.cos(d.aim) - my * Math.sin(d.aim)),
        y: d.head.y + mx * Math.sin(d.aim) + my * Math.cos(d.aim),
      };

      // The tail is dragged behind, each link following the one before.
      d.tail[0] = { x: d.body.x - f * 12 * BULK, y: d.body.y + BULK };
      for (let i = 1; i < TAIL; i++) {
        const p = d.tail[i];
        const prev = d.tail[i - 1];
        p.x -= f * 14 * dt;
        p.y += d.perched ? 22 * dt : (6 + Math.sin(time * 5 - i * 0.5) * 10) * dt;
        const len = gap(p, prev) || 1;
        p.x = prev.x + ((p.x - prev.x) / len) * LINK;
        p.y = prev.y + ((p.y - prev.y) / len) * LINK;
      }
      d.hurt -= dt;
      d.cry -= dt;
    };

    const strike = (b: Bolt) => {
      burst("soul", 20, b.at, 70, 0.6);
      for (let i = 0; i < 18; i++) mote("blood", b.at.x, b.at.y, rand(-55, 55) + b.vel.x * 0.25, rand(-95, -10), 3);
      dragon.hurt = 0.14;
      dragon.cry = 0.7;
      dragon.vel.x += b.vel.x * 0.5;
      dragon.vel.y += b.vel.y * 0.5;
    };

    /** The ledge a falling mote has just come down onto. */
    const landed = (m: Mote, from: number) =>
      m.vy > 0 ? terrain.find((l) => from < l.y && m.y >= l.y && m.x >= l.x0 && m.x <= l.x1) : undefined;

    const step = (now: number) => {
      // The first frame can be stamped before the time taken here.
      const dt = clamp((now - last) / 1000, 0, 0.05);
      last = now;
      time += dt;
      waited += dt;
      while (typeof wait === "number" ? waited >= wait : wait() || waited > 8) {
        wait = script.next().value;
        waited = 0;
      }

      // The wizard comes and goes in smoke.
      wizard.here = clamp(wizard.here + ((wizard.shown ? 1 : -1) * dt) / 0.3, 0, 1);
      wizard.ward = clamp(wizard.ward + ((wizard.warding ? 1 : -1) * dt) / 0.25, 0, 1);
      if (wizard.shown && wizard.here >= 1) wizard.facing = dragon.body.x < wizard.at.x ? -1 : 1;
      if (wizard.here > 0 && wizard.here < 1) {
        for (let i = 0; i < 3; i++) {
          mote(i ? "smoke" : "soul", wizard.at.x + rand(-6, 6), wizard.at.y - rand(0, 26), rand(-10, 10), rand(-28, -6), rand(0.4, 0.9));
        }
      }
      if (wizard.casting && Math.random() < dt * 30) burst("soul", 1, skull(), 18, 0.5);

      moveDragon(dt);
      if (dragon.fire) {
        for (flames += dt * 220; flames >= 1; flames--) {
          const a = dragon.aim + rand(-0.13, 0.13);
          const v = rand(120, 175);
          mote("fire", dragon.mouth.x, dragon.mouth.y, dragon.facing * Math.cos(a) * v + dragon.vel.x * 0.5, Math.sin(a) * v, rand(0.8, 1.3));
        }
      } else if (dragon.perched && Math.random() < dt * 1.5) {
        mote("smoke", dragon.mouth.x, dragon.mouth.y - 4, rand(-4, 4), rand(-10, -5), 1.4);
      }

      for (const b of bolts) {
        b.age += dt;
        if (b.sure) {
          const far = gap(dragon.body, b.at) || 1;
          b.vel.x += (((dragon.body.x - b.at.x) / far) * 170 - b.vel.x) * Math.min(1, dt * 5);
          b.vel.y += (((dragon.body.y - b.at.y) / far) * 170 - b.vel.y) * Math.min(1, dt * 5);
        }
        b.at.x += b.vel.x * dt;
        b.at.y += b.vel.y * dt;
        if (Math.random() < dt * 60) mote("soul", b.at.x, b.at.y, rand(-6, 6), rand(-6, 6), 0.4);
      }
      bolts = bolts.filter((b) => {
        if (gap(b.at, dragon.body) < 12 * BULK || gap(b.at, dragon.head) < 9 * BULK) {
          strike(b);
          return false;
        }
        return b.age < 5 && b.at.x > -20 && b.at.x < w + 20 && b.at.y > -20 && b.at.y < h + 20;
      });

      const ward = chest();
      const kept: Mote[] = [];
      for (const m of motes) {
        if ((m.age += dt) >= m.life) continue;
        const from = m.y;
        if (m.kind === "blood") m.vy += 220 * dt;
        else {
          m.vx *= 1 - 0.7 * dt;
          m.vy = m.vy * (1 - 0.7 * dt) - (m.kind === "soul" ? 0 : 22 * dt);
        }
        m.x += m.vx * dt;
        m.y += m.vy * dt;
        if (m.kind === "fire" && wizard.ward > 0.5 && wizard.here >= 1 && Math.hypot(m.x - ward.x, m.y - ward.y) < WARD) {
          // Turned away as smoke.
          m.kind = "smoke";
          m.vx = -Math.sign(m.vx) * rand(5, 35);
          m.vy = rand(-45, -15);
          m.life = m.age + rand(0.5, 1);
        }
        const l = m.kind === "fire" || m.kind === "blood" ? landed(m, from) : undefined;
        if (l) {
          const x = Math.round(m.x);
          const fire = m.kind === "fire";
          marks.set(`${fire}${x},${l.y}`, {
            x,
            y: l.y,
            age: 0,
            life: fire ? rand(5, 9) : rand(18, 30),
            burn: fire ? rand(1.2, 3) : 0,
            drip: fire ? 0 : Math.floor(rand(0, 4)),
          });
          continue;
        }
        kept.push(m);
      }
      motes = kept;

      // Draw: what's on the ledges, the two of them, then what's in the air.
      ctx.clearRect(0, 0, w, h);
      for (const [key, m] of marks) {
        if ((m.age += dt) >= m.life) {
          marks.delete(key);
          continue;
        }
        if (m.age < m.burn) {
          const tall = 1 + ((m.x * 13 + Math.floor(time * 10) * 7) % 3);
          ctx.globalAlpha = 1;
          ctx.fillStyle = "#f2601c";
          ctx.fillRect(m.x, m.y - tall, 1, tall + 1);
          ctx.fillStyle = "#ffcf5a";
          ctx.fillRect(m.x, m.y - tall, 1, 1);
          if (Math.random() < dt * 0.6) mote("smoke", m.x, m.y - tall, rand(-3, 3), rand(-12, -6), 1.2);
        } else if (m.burn) {
          ctx.globalAlpha = 1 - (m.age - m.burn) / (m.life - m.burn);
          ctx.fillStyle = "#b5391a";
          ctx.fillRect(m.x, m.y, 1, 1);
        } else {
          ctx.globalAlpha = Math.min(1, (1 - m.age / m.life) * 3);
          ctx.fillStyle = "#7d0c11";
          ctx.fillRect(m.x, m.y, 1, 1 + Math.min(m.drip, Math.floor(m.age * 1.5)));
        }
      }
      ctx.globalAlpha = 1;

      layer.clearRect(0, 0, w, h);
      drawDragon(layer, dragon, dragon.hurt > 0 ? STRUCK : dragon.fire ? HOT : HIDE);
      drawWizard(layer, wizard);
      rim.globalCompositeOperation = "copy";
      rim.drawImage(figures, 0, 0);
      rim.globalCompositeOperation = "source-in";
      rim.fillStyle = RIM;
      rim.fillRect(0, 0, w, h);
      for (const [x, y] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) ctx.drawImage(edges, x, y);
      ctx.drawImage(figures, 0, 0);

      for (const m of motes) {
        const fade = 1 - m.age / m.life;
        ctx.globalAlpha = m.kind === "smoke" ? fade * 0.6 : Math.min(1, fade * 3);
        ctx.fillStyle = tint(m);
        const fat = m.kind === "fire" && m.age < 0.45 ? 2 : 1;
        ctx.fillRect(Math.round(m.x), Math.round(m.y), fat, fat);
      }
      if (wizard.ward > 0) {
        const toward = Math.atan2(dragon.head.y - ward.y, dragon.head.x - ward.x);
        ctx.fillStyle = SOUL;
        for (let a = -1.25; a <= 1.25; a += 0.1) {
          ctx.globalAlpha = wizard.ward * (0.45 + 0.4 * Math.sin(time * 14 + a * 9));
          ctx.fillRect(Math.round(ward.x + Math.cos(toward + a) * WARD), Math.round(ward.y + Math.sin(toward + a) * WARD), 1, 1);
        }
      }
      ctx.globalAlpha = 1;
      for (const b of bolts) {
        const x = Math.round(b.at.x);
        const y = Math.round(b.at.y);
        ctx.fillStyle = SOUL;
        ctx.fillRect(x - 2, y - 1, 5, 3);
        ctx.fillRect(x - 1, y - 2, 3, 5);
        ctx.fillStyle = "#f1ffe0";
        ctx.fillRect(x - 1, y, 3, 1);
        ctx.fillRect(x, y - 1, 1, 3);
      }

      frame = requestAnimationFrame(step);
    };
    let last = performance.now();
    let frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [canvas, size]);
}

/** The scene is drawn small and scaled up without smoothing, coarser on a wider window. */
function measure(): Size {
  const scale = Math.max(2, Math.min(4, Math.round(window.innerWidth / 430)));
  return { scale, w: Math.ceil(window.innerWidth / scale), h: Math.ceil(window.innerHeight / scale) };
}

function Fight() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState(measure);
  useEffect(() => {
    const resize = () => setSize(measure());
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useFight(canvas, size);
  return <canvas ref={canvas} width={size.w} height={size.h} style={{ width: size.w * size.scale, height: size.h * size.scale }} />;
}

/**
 * After `minutes` with 3Devil focused and nothing pressed or moved, a dragon
 * and a necromancer fight across the window, on top of whatever it's showing,
 * until you come back.
 */
export function Screensaver({ minutes }: { minutes: number }) {
  const [on, setOn] = useState(false);
  const onRef = useRef(false);
  useEffect(() => {
    if (!minutes || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let at = { x: -1, y: -1 };
    const show = (value: boolean) => {
      onRef.current = value;
      setOn(value);
    };
    const restart = () => {
      clearTimeout(timer);
      if (onRef.current) show(false);
      if (document.hasFocus()) timer = setTimeout(() => show(true), minutes * 60_000);
    };
    // The page can see a move without the mouse moving, as when the fight appears under it.
    const moved = (e: PointerEvent) => {
      const far = Math.hypot(e.clientX - at.x, e.clientY - at.y) > 3;
      at = { x: e.clientX, y: e.clientY };
      if (far || !onRef.current) restart();
    };
    // The key that wakes the app shouldn't also do something in it.
    const key = (e: KeyboardEvent) => {
      if (onRef.current) {
        e.preventDefault();
        e.stopPropagation();
      }
      restart();
    };
    const blur = () => {
      clearTimeout(timer);
      show(false);
    };
    window.addEventListener("pointermove", moved, true);
    window.addEventListener("pointerdown", restart, true);
    window.addEventListener("wheel", restart, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("focus", restart);
    window.addEventListener("blur", blur);
    restart();
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", moved, true);
      window.removeEventListener("pointerdown", restart, true);
      window.removeEventListener("wheel", restart, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("focus", restart);
      window.removeEventListener("blur", blur);
      show(false);
    };
  }, [minutes]);
  if (!on) return null;
  return (
    <div className="screensaver" aria-hidden>
      <Fight />
    </div>
  );
}
