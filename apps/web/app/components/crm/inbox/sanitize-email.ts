// Use the browser's inert HTML parser, not regex parsing. No new runtime dependency
// is needed; every element and attribute is checked before serialisation.
const TAGS: Record<string, true> = Object.fromEntries("html head body title style a abbr address article aside b bdi bdo blockquote br caption center code col colgroup dd del details div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr i img ins label li main mark ol p pre s section small span strike strong sub summary sup table tbody td tfoot th thead tr u ul wbr".split(" ").map((tag) => [tag, true]));
const ATTRS: Record<string, true> = Object.fromEntries("align alt bgcolor border cellpadding cellspacing class color colspan dir face height id lang rowspan size style title type valign width".split(" ").map((attribute) => [attribute, true]));
const QUOTES = ".gmail_quote, .gmail_extra, .gmail_signature, blockquote[type=cite], #divRplyFwdMsg, #appendonsend, .OutlookMessageHeader";

function cleanCss(css: string): string {
  // Disallow escapes/comments (which can disguise tokens), all network-bearing
  // constructs and legacy executable CSS. Ordinary newsletter typography survives.
  return css.replace(/\/\*[\s\S]*?\*\//g, "").split(/(?<=;|\})/).filter((rule) => !/\\|url\s*\(|expression\s*\(|@import|@font-face|behavior\s*:|-moz-binding|image-set\s*\(/i.test(rule)).join("");
}

export function prepareEmail(html: string, loadImages = false, showQuoted = false): { srcdoc: string; hasRemoteImages: boolean; hasQuoted: boolean } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  let hasRemoteImages = false;
  for (const element of Array.from(doc.querySelectorAll("*"))) {
    const tag = element.localName;
    if (!Object.hasOwn(TAGS, tag) || element.namespaceURI !== "http://www.w3.org/1999/xhtml") { element.remove(); continue; }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name === "href" && tag === "a") {
        const value = attribute.value.trim();
        if (!/^(?:https?:|mailto:|tel:)/i.test(value)) element.removeAttribute(name);
      } else if (name === "src" && tag === "img") {
        const value = attribute.value.trim();
        if (/^https:\/\//i.test(value)) {
          hasRemoteImages = true;
          if (!loadImages) element.removeAttribute(name);
        } else if (!/^data:image\/(?:png|gif|jpe?g|webp);base64,[a-z0-9+/=\s]+$/i.test(value)) {
          element.removeAttribute(name);
          if (/^cid:/i.test(value)) element.remove();
        }
      } else if (!Object.hasOwn(ATTRS, name)) element.removeAttribute(name);
    }
    if (element.hasAttribute("style")) element.setAttribute("style", cleanCss(element.getAttribute("style")!));
    if (tag === "style") element.textContent = cleanCss(element.textContent || "");
    if (tag === "a") { element.setAttribute("target", "_blank"); element.setAttribute("rel", "noopener noreferrer nofollow"); }
  }
  const quotes = Array.from(doc.querySelectorAll(QUOTES));
  if (!showQuoted) for (const quote of quotes) {
    // Outlook's marker is often a header preceding history, not a container.
    if (quote.matches("#divRplyFwdMsg, #appendonsend")) {
      let next = quote.nextSibling;
      while (next) { const following = next.nextSibling; next.remove(); next = following; }
    }
    quote.remove();
  }
  const styles = Array.from(doc.querySelectorAll("style")).map((style) => style.outerHTML).join("");
  for (const style of Array.from(doc.body.querySelectorAll("style"))) style.remove();
  const csp = `default-src 'none'; script-src 'none'; img-src data:${loadImages ? " https:" : ""}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`;
  const defaults = `:root{color-scheme:light}html{background:#fff}body{margin:0;padding:0;background:#fff;color:#1a1a1a;font:14px/1.55 Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;overflow-wrap:anywhere;display:flow-root}img{max-width:100%!important;height:auto}table{max-width:100%}pre{white-space:pre-wrap}a{overflow-wrap:anywhere}`;
  // CSP precedes every email style or element, including full-document messages.
  return { srcdoc: `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style>${defaults}</style>${styles}</head><body${doc.body.getAttribute("style") ? ` style="${doc.body.getAttribute("style")!.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"` : ""}>${doc.body.innerHTML}</body></html>`, hasRemoteImages, hasQuoted: quotes.length > 0 };
}
