#!/usr/bin/env python3
"""Builds one self-contained preview page from rendered views and compiled CSS.

  assemble.py --css app.css --out preview.html --title "Bulk Trades" \
    --view list=list.html --view board=board.html [--nav nav.json] [--note "Sample data"]

Each view is the body HTML a render test wrote. The first view shows first. nav.json lists click
rules, checked in order, that switch views (the page is static, so app buttons do nothing else):
  [{"within": "nav[aria-label=View]", "view": "$text"},       # view named by the button text
   {"text": "Iveco FPT eBS37", "view": "overview"},          # button whose text starts with this
   {"role": "tab", "view": {"Overview": "overview", "Data and files": "data"}}]
The wrapper follows the viewer's light or dark theme by toggling the app's `dark` class.
"""
import argparse, html, json

p = argparse.ArgumentParser()
p.add_argument("--css", required=True)
p.add_argument("--out", required=True)
p.add_argument("--title", required=True)
p.add_argument("--view", action="append", required=True, help="name=path")
p.add_argument("--nav")
p.add_argument("--note", default="")
p.add_argument("--fonts", default="Geist:wght@400;500;600;700&family=Geist+Mono:wght@500&family=Inter:wght@400;500;600;700")
a = p.parse_args()

css = open(a.css).read().replace("</style", "<\\/style")
views = [v.split("=", 1) for v in a.view]
blocks = "\n".join(
    f'<div data-view="{name}"{"" if i == 0 else " hidden"}>{open(path).read()}</div>'
    for i, (name, path) in enumerate(views)
)
rules = json.load(open(a.nav)) if a.nav else []
note = f'<p class="preview-note">{html.escape(a.note)}</p>' if a.note else ""

page = f"""<title>{html.escape(a.title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family={a.fonts}&display=swap">
<style>{css}</style>
<style>
:root {{ --preview-bg: #f7f7f5; --preview-note: #6b6a65; --preview-note-bg: #efeeea; }}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{ --preview-bg: #1b1b1a; --preview-note: #9a9993; --preview-note-bg: #222221; color-scheme: dark; }} }}
:root[data-theme="dark"] {{ --preview-bg: #1b1b1a; --preview-note: #9a9993; --preview-note-bg: #222221; color-scheme: dark; }}
html, body {{ height: auto; background: var(--preview-bg); }}
.preview-note {{ font: 13px/1.4 system-ui, sans-serif; color: var(--preview-note); background: var(--preview-note-bg); padding: 8px 16px; margin: 0; }}
.preview-frame {{ overflow-x: auto; }}
.preview-frame > div > div {{ min-width: 1100px; min-height: 1000px; }}
</style>
{note}
<div id="preview-root" class="preview-frame">
{blocks}
</div>
<script>
(function () {{
  var root = document.getElementById("preview-root");
  var rules = {json.dumps(rules)};
  var mq = window.matchMedia("(prefers-color-scheme: dark)");
  function theme() {{
    var t = document.documentElement.getAttribute("data-theme");
    root.classList.toggle("dark", t ? t === "dark" : mq.matches);
  }}
  theme();
  mq.addEventListener("change", theme);
  new MutationObserver(theme).observe(document.documentElement, {{ attributes: true, attributeFilter: ["data-theme"] }});
  function show(view) {{
    if (!root.querySelector('[data-view="' + view + '"]')) return;
    root.querySelectorAll("[data-view]").forEach(function (el) {{ el.hidden = el.dataset.view !== view; }});
    window.scrollTo(0, 0);
  }}
  root.addEventListener("click", function (event) {{
    var button = event.target.closest("button, [role=tab]");
    if (!button) return;
    var text = button.textContent.trim();
    for (var i = 0; i < rules.length; i++) {{
      var r = rules[i];
      if (r.within && !button.closest(r.within)) continue;
      if (r.role && button.getAttribute("role") !== r.role) continue;
      if (r.text && text.indexOf(r.text) !== 0) continue;
      var view = r.view === "$text" ? text.toLowerCase() : typeof r.view === "object" ? r.view[text] : r.view;
      if (view) return show(view);
    }}
  }});
}})();
</script>
"""
open(a.out, "w").write(page)
print(a.out)
