import { extractAttachedFilePaths } from "@/lib/chat-image-common";

export interface UserAttachment { path: string; name: string; image: boolean }
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|heic|tiff?)$/i;
const attachment = (path: string): UserAttachment => ({ path, name: path.split("/").pop() || path, image: IMAGE.test(path) });

/**
 * User rows carry machine markup: an `[Attached files: a, b]` prefix from the CRM and, once Hermes stages an image,
 * `@image:<path>` / `[screenshot]` / `[User attached image: …]` lines. Split them out so the bubble shows only the message.
 */
export function parseUserAttachments(text: string): { attachments: UserAttachment[]; message: string } {
  const files = extractAttachedFilePaths(text).map(attachment);
  let rest = text.replace(/\[Attached files:[^\]]*\]/g, "");
  const staged: UserAttachment[] = [];
  rest = rest.replace(/^[ \t]*@image:(\S+)[ \t]*$/gm, (_, path: string) => { staged.push(attachment(path)); return ""; })
    .replace(/^[ \t]*\[User attached image:[^\]]*\][ \t]*$/gm, "")
    .replace(/^[ \t]*\[(?:screenshot|image|photo)\][ \t]*$/gm, "");
  // Hermes re-stages the CRM's own image attachments; show each image once.
  const shown = files.filter(file => file.image).length >= staged.length ? files : [...files, ...staged.slice(files.filter(file => file.image).length)];
  return { attachments: shown, message: rest.replace(/\n{3,}/g, "\n\n").trim() };
}
