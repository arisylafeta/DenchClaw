# Buyer dossier fixtures

One pair per case: `<name>.md` is a dossier, `<name>.json` is what the parser, the validator and the
deriver must return for it.

```json
{
  "frontmatter": {},   // parse() output
  "body": "",          // text after the closing fence
  "errors": [],        // validate() output; non-empty means nothing may be written
  "profile": null      // to_buyer_profile() output, or null when there are errors
}
```

Two suites read these fixtures, so the TypeScript runtime deriver (`apps/web/lib/buyer-dossier.ts`)
and the Python module (`scripts/rebattery/buyer_dossier.py`) cannot drift silently:

- `apps/web/lib/buyer-dossier.test.ts` (`npx vitest run lib/buyer-dossier.test.ts`)
- `scripts/rebattery/test_buyer_dossier.py` (`python3 -m unittest test_buyer_dossier`)

Synthetic companies only. No real company data belongs in git.

`merge.json` holds the merge cases (existing profile + dossier frontmatter -> expected profile,
pass-through keys and changed flag). Both suites read it, so the derive-as-merge rule that
`saveDossier`, the loader and the Python module each rely on is exercised in one place.

Regenerate the expected JSON from the Python module after changing a `.md` fixture (the Python module
is the schema's written reference; the TypeScript suite then proves the runtime matches it):

```sh
cd scripts/rebattery && python3 - <<'PY'
import json, sys
from pathlib import Path
sys.path.insert(0, '.')
import buyer_dossier as bd
for md in sorted(Path('fixtures/buyer_dossier').glob('*.md')):
    if md.name == 'README.md':
        continue
    fm, body = bd.load(md)
    errors = bd.validate(fm)
    out = {'frontmatter': fm, 'body': body, 'errors': errors,
           'profile': None if errors else bd.to_buyer_profile(fm)}
    md.with_suffix('.json').write_text(json.dumps(out, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
PY
```
