import defaultAvatar from "@/public/profile-avatars/default.png";
import investigatorAvatar from "@/public/profile-avatars/investigator.png";
import mailvinAvatar from "@/public/profile-avatars/mailvin.png";
import enrichoAvatar from "@/public/profile-avatars/enricho.png";
import devonAvatar from "@/public/profile-avatars/devon.png";
import matchaAvatar from "@/public/profile-avatars/matcha.png";
import vangridAvatar from "@/public/profile-avatars/vangrid.png";
import sorcererAvatar from "@/public/profile-avatars/sorcerer.png";
import papajulesAvatar from "@/public/profile-avatars/papajules.png";
import pennyAvatar from "@/public/profile-avatars/penny.png";

/** A bot's blob: a bloub body shape and palette colour id. */
export type BlobLook = { shape: string; color: string };

const SHAPES = ["cercle", "galet", "squircle", "capsule", "triangle", "hexagone", "nuage", "goutte"];
const COLORS = ["orange", "vert", "bleu", "rouge", "violet", "ambre", "turquoise", "rose", "gris", "brun"];

// Legacy IDs keep their identity for historical conversations after a profile rename.
const looks: Record<string, BlobLook> = {
  default: { shape: "cercle", color: "turquoise" },
  devon: { shape: "capsule", color: "orange" },
  matcha: { shape: "cercle", color: "vert" },
  mailvin: { shape: "capsule", color: "bleu" },
  outbounder: { shape: "capsule", color: "bleu" },
  investigator: { shape: "galet", color: "rouge" },
  enricho: { shape: "hexagone", color: "gris" },
  "the-enricher": { shape: "hexagone", color: "gris" },
  papajules: { shape: "goutte", color: "orange" },
  sorcerer: { shape: "triangle", color: "violet" },
  vangrid: { shape: "squircle", color: "ambre" },
  penny: { shape: "nuage", color: "rose" },
};

function hash(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Fixed look for known bots; a stable shape and colour derived from the name for new ones. */
export function profileBlob(name: string): BlobLook {
  if (Object.hasOwn(looks, name)) return looks[name];
  const h = hash(name);
  return { shape: SHAPES[h % SHAPES.length], color: COLORS[Math.floor(h / SHAPES.length) % COLORS.length] };
}

// Raster stills of the same blobs, used as notification icons.
// Next emits imported images at content-hashed, immutable-cache URLs.
const stills: Record<string, { src: string } | string> = {
  default: defaultAvatar,
  investigator: investigatorAvatar,
  mailvin: mailvinAvatar,
  outbounder: mailvinAvatar,
  enricho: enrichoAvatar,
  "the-enricher": enrichoAvatar,
  devon: devonAvatar,
  matcha: matchaAvatar,
  vangrid: vangridAvatar,
  sorcerer: sorcererAvatar,
  papajules: papajulesAvatar,
  penny: pennyAvatar,
};

export function bundledProfileAvatar(name: string): string | undefined {
  const avatar = Object.hasOwn(stills, name) ? stills[name] : undefined;
  return typeof avatar === "string" ? avatar : avatar?.src;
}
