export type FocusTable = { id: string; x: number; y: number; subject: string };

export type DecorType =
  | "window"
  | "lamp"
  | "plant"
  | "monitor"
  | "fireplace"
  | "tree"
  | "bookshelf"
  | "neonSign"
  | "rug"
  | "bench"
  | "fountain"
  | "painting"
  | "chandelier"
  | "arcade"
  | "floorLight"
  | "stringLights"
  | "hangingBulb"
  | "sofa"
  | "coffeeTable"
  | "barCounter"
  | "menuBoard"
  | "candle"
  | "framedSign";

export type Decor = {
  type: DecorType;
  x: number;
  y: number;
  w?: number;
  h?: number;
  color?: number;
  text?: string;
  /** Endpoint for spanning decor (stringLights). */
  x2?: number;
  y2?: number;
  /** Count for repeating elements (e.g. bulbs along a string). */
  count?: number;
};

export type FloorStyle = "tiles" | "planks";
export type WallStyle = "plain" | "brick";

export type Weather = "rain" | "dust" | "leaves" | "neon" | "sun";

export type MapDef = {
  id: string;
  name: string;
  tagline: string;
  floor: number;
  wall: number;
  accent: number;
  ambient: number;
  emoji: string;
  tables: FocusTable[];
  weather: Weather;
  lightColor: number;
  lightStrength: number;
  decor: Decor[];
  /** Ambient sound IDs that auto-suggest when joining this room. */
  soundSuggestions: string[];
  /** Optional richer floor rendering. Defaults to "tiles". */
  floorStyle?: FloorStyle;
  /** Optional richer wall rendering. Defaults to "plain". */
  wallStyle?: WallStyle;
  /** Optional secondary floor color for grain / planks. */
  floorAccent?: number;
  /** Optional full-room background image (skips procedural floor/walls/decor). */
  bgImage?: string;
};

// Tables are now user-created at runtime (see public.room_tables).
// Maps no longer ship with predefined tables / fixed subjects.

const W = 1600;
const H = 1200;

const topWindows = (count: number, color = 0x9bcaf0): Decor[] =>
  Array.from({ length: count }, (_, i) => ({
    type: "window" as const, x: 160 + i * ((W - 320) / Math.max(count - 1, 1)), y: 60, w: 140, h: 90, color,
  }));

const wallLamps = (count: number, color = 0xf0c987): Decor[] =>
  Array.from({ length: count }, (_, i) => ({
    type: "lamp" as const, x: 140 + i * ((W - 280) / Math.max(count - 1, 1)), y: 150, color,
  }));

export const MAPS: MapDef[] = [
  // ─── COZY CAFÉ ───────────────────────────────────────────────────────────────
  {
    id: "cafe",
    name: "Cozy Café",
    tagline: "Rain on the window, espresso machine humming",
    floor: 0x2a1810, wall: 0x1a0e08, accent: 0xf0c987, ambient: 0xe8a87c,
    emoji: "☕",
    tables: [],
    soundSuggestions: ["rain", "cafe", "lofi"],
    weather: "rain",
    lightColor: 0x1a0a04, lightStrength: 0.0,
    // The bg image already contains the full café environment (floor, walls, rug,
    // bookshelves, lamps, windows, bar). Procedural decor is skipped when present.
    bgImage: "/cafe-bg-v2.png",
    decor: [],
  },

  // ─── SILENT LIBRARY ──────────────────────────────────────────────────────────
  {
    id: "library",
    name: "Silent Library",
    tagline: "Hushed pages, golden light through tall windows",
    floor: 0x3b2a1a, wall: 0x1f1610, accent: 0xc9a352, ambient: 0xf0c987,
    emoji: "📚",
    tables: [],
    soundSuggestions: ["library", "instrumental", "white"],
    weather: "dust",
    lightColor: 0x2a1c10, lightStrength: 0.28,
    decor: [
      ...topWindows(5, 0xd4b870),
      ...wallLamps(7, 0xffd388),
      { type: "bookshelf", x: 55, y: 300, w: 65, h: 350, color: 0x2a1810 },
      { type: "bookshelf", x: 55, y: 680, w: 65, h: 350, color: 0x2a1810 },
      { type: "bookshelf", x: 55, y: 1020, w: 65, h: 280, color: 0x2a1810 },
      { type: "bookshelf", x: W - 55, y: 300, w: 65, h: 350, color: 0x2a1810 },
      { type: "bookshelf", x: W - 55, y: 680, w: 65, h: 350, color: 0x2a1810 },
      { type: "bookshelf", x: W - 55, y: 1020, w: 65, h: 280, color: 0x2a1810 },
      { type: "rug", x: W / 2, y: H / 2, w: 800, h: 440, color: 0x5a3a1e },
      { type: "chandelier", x: W / 2, y: 80, color: 0xffd388 },
      { type: "chandelier", x: W / 4, y: 80, color: 0xffd388 },
      { type: "chandelier", x: (W / 4) * 3, y: 80, color: 0xffd388 },
      { type: "painting", x: W / 2, y: 80, color: 0xc9a352 },
    ],
  },

  // ─── PROGRAMMING HUB ─────────────────────────────────────────────────────────
  {
    id: "hub",
    name: "Programming Hub",
    tagline: "Neon glow, mechanical keys clacking",
    floor: 0x0d1424, wall: 0x06080f, accent: 0x4ade80, ambient: 0xa78bfa,
    emoji: "💻",
    tables: [],
    soundSuggestions: ["keyboard", "lofi", "focus"],
    weather: "neon",
    lightColor: 0x080c1a, lightStrength: 0.0,
    bgImage: "/hub-bg.png",
    decor: [],
  },

  // ─── UNIVERSITY HALL ─────────────────────────────────────────────────────────
  {
    id: "hall",
    name: "University Hall",
    tagline: "Tall windows, the buzz of group study",
    floor: 0x3a2f48, wall: 0x1e1830, accent: 0xe8a87c, ambient: 0xf0c987,
    emoji: "🎓",
    tables: [],
    soundSuggestions: ["library", "instrumental"],
    weather: "dust",
    lightColor: 0x1a1230, lightStrength: 0.28,
    decor: [
      ...topWindows(7, 0xeab87c),
      ...wallLamps(8, 0xffe1a8),
      { type: "bookshelf", x: 60, y: 400, w: 55, h: 600, color: 0x2a1f3a },
      { type: "bookshelf", x: 60, y: 950, w: 55, h: 400, color: 0x2a1f3a },
      { type: "bookshelf", x: W - 60, y: 400, w: 55, h: 600, color: 0x2a1f3a },
      { type: "bookshelf", x: W - 60, y: 950, w: 55, h: 400, color: 0x2a1f3a },
      { type: "plant", x: 200, y: H - 90 },
      { type: "plant", x: W - 200, y: H - 90 },
      { type: "chandelier", x: W / 2, y: 80, color: 0xffe1a8 },
      { type: "painting", x: W / 2, y: 75, color: 0xe8a87c },
      { type: "rug", x: W / 2, y: H / 2, w: 900, h: 600, color: 0x4a3060 },
    ],
  },

  // ─── FOCUS PARK ──────────────────────────────────────────────────────────────
  {
    id: "park",
    name: "Focus Park",
    tagline: "Birdsong and a breeze through the leaves",
    floor: 0x2e4a2a, wall: 0x1b2e1a, accent: 0xf0c987, ambient: 0x7dd3a8,
    emoji: "🌳",
    tables: [],
    soundSuggestions: ["nature", "fire"],
    weather: "leaves",
    lightColor: 0xffb070, lightStrength: 0.18,
    decor: [
      { type: "tree", x: 140, y: 180 },
      { type: "tree", x: W - 140, y: 180 },
      { type: "tree", x: 90, y: 650 },
      { type: "tree", x: W - 90, y: 650 },
      { type: "tree", x: 280, y: H - 120 },
      { type: "tree", x: W - 280, y: H - 120 },
      { type: "tree", x: W / 2 - 500, y: 250 },
      { type: "tree", x: W / 2 + 500, y: 250 },
      { type: "tree", x: W / 2, y: H - 100 },
      { type: "fountain", x: W / 2, y: H - 200 },
      { type: "bench", x: 260, y: H - 220 },
      { type: "bench", x: W - 260, y: H - 220 },
      { type: "bench", x: W / 2 - 180, y: H - 250 },
      { type: "bench", x: W / 2 + 180, y: H - 250 },
      { type: "lamp", x: 280, y: 200, color: 0xfff3c4 },
      { type: "lamp", x: W - 280, y: 200, color: 0xfff3c4 },
      { type: "lamp", x: 280, y: H - 280, color: 0xfff3c4 },
      { type: "lamp", x: W - 280, y: H - 280, color: 0xfff3c4 },
    ],
  },
];

export const getMap = (id: string) => MAPS.find((m) => m.id === id) ?? MAPS[0];

export const AVATAR_COLORS = [
  { id: 0, name: "Sand",   body: 0xf0c987, hair: 0x4a2e1f },
  { id: 1, name: "Coral",  body: 0xe8a87c, hair: 0x2b1d14 },
  { id: 2, name: "Lilac",  body: 0xc9a0dc, hair: 0x2b1d3a },
  { id: 3, name: "Sage",   body: 0xa8c0a0, hair: 0x1b2e1a },
  { id: 4, name: "Mint",   body: 0x7dd3a8, hair: 0x0d1424 },
  { id: 5, name: "Sky",    body: 0x7dd3fc, hair: 0x1f2a44 },
];

export type Gender = "male" | "female";

/** Returns the character's shirt + pants + skin/hair palette.
 * Male = blue shirt, dark pants. Female = pink shirt, dark pants + feminine hair.
 * Designed so additional styles (avatarId-driven accents) can layer on later. */
export function getCharacterStyle(gender: Gender) {
  if (gender === "female") {
    return {
      shirt: 0xec4899,   // pink
      pants: 0x1f2937,   // dark slate
      skin:  0xf4c79b,
      hair:  0x5b2a86,   // soft plum
      hairStyle: "long" as const,
    };
  }
  return {
    shirt: 0x3b82f6,     // blue
    pants: 0x1f2937,
    skin:  0xf0c987,
    hair:  0x3a2418,
    hairStyle: "short" as const,
  };
}
