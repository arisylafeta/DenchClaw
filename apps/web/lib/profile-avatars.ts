import defaultAvatar from "@/public/profile-avatars/default.webp";
import investigatorAvatar from "@/public/profile-avatars/investigator.webp";
import mailvinAvatar from "@/public/profile-avatars/mailvin.webp";
import enrichoAvatar from "@/public/profile-avatars/enricho.webp";
import devonAvatar from "@/public/profile-avatars/devon.webp";
import matchaAvatar from "@/public/profile-avatars/matcha.webp";
import vangridAvatar from "@/public/profile-avatars/vangrid.webp";
import pennyAvatar from "@/public/profile-avatars/penny.webp";

// Next emits imported images at content-hashed, immutable-cache URLs.
// Legacy IDs remain useful for historical conversations after a profile rename.
const avatars: Record<string, { src: string } | string> = {
  default: defaultAvatar,
  investigator: investigatorAvatar,
  mailvin: mailvinAvatar,
  outbounder: mailvinAvatar,
  enricho: enrichoAvatar,
  "the-enricher": enrichoAvatar,
  devon: devonAvatar,
  matcha: matchaAvatar,
  vangrid: vangridAvatar,
  penny: pennyAvatar,
};

export function bundledProfileAvatar(name: string): string | undefined {
  const avatar = Object.hasOwn(avatars, name) ? avatars[name] : undefined;
  return typeof avatar === "string" ? avatar : avatar?.src;
}
