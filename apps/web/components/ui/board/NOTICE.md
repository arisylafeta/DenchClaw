# BoardUI components, vendored

`apps/web/components/ui/board` holds a small, adapted copy of the free BoardUI
components. Only components that need nothing beyond React, Tailwind, `clsx` and
`tailwind-merge` are vendored: React Aria based inputs, tables and tabs are not.

Changes from the originals: BoardUI's own theme tokens are replaced with the
DenchClaw tokens in `DESIGN.md` (light and dark), `@/utils/cx` is replaced with
this repository's `cn` (`@/lib/utils`), the Remix Icon dependency is dropped in
favour of plain icon components, and the Figma commentary is trimmed to what a
reader here needs. Behaviour, sizes and spacing follow BoardUI.

Source: BoardUI (https://github.com/boardui/boardui), MIT licensed.

---

MIT License

Copyright (c) 2026 Mertcan Dundar Esmergul (BoardUI)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
