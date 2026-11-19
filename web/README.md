# PAWS web proof of concept

Runs the existing PAWS pages in Microsoft Edge (or Chrome) instead of the JavaFX shell,
reading and writing `.paw` and `.grm` files on the local disk.

## Try it

```
node web/serve.mjs
```

Then open http://localhost:8080/ in Edge. There is no build step and nothing to install
beyond Node (used only as a static file server).

## What works

- **New / Open / Save / Save as** for `.paw` files through the File System Access API.
  Changes autosave to the open file, as in the desktop app. The last file is remembered;
  Edge asks once per session to allow editing it again.
- **All question pages**: the page descriptions in `XmlPageDescriptions` are turned into
  pages by `PAWSSKHtmlMapper.xsl` in the browser. The DTD's entities and default
  attribute values are applied first (`js/dtd.js`), because the stylesheets depend on them.
- **The `pawsApp` bridge** (`js/app.js`) implements the same methods the pages call on the
  Java side (`getAnswerValue`, `setAnswerValue`, `load`, `saveData`, `setLeftOffAt`, …).
  The pages themselves are unchanged.
- **Generate grammar** writes the PC-PATR `.grm` file with `PAWSSKMasterGrammarMapper.xsl`.
  Shift+click chooses a different file.
- **Interface language** switching (English, Spanish, French).

## Not yet

- Writer outputs (XLingPaper, English/French/Spanish): those stylesheets use `xsl:import`
  and `document()`, and need the XLingPaper post-processing ported from `OutputGenerator`.
- Parameterized example files (needs a folder picker).
- Data migration of older `.paw` files (`DatabaseMigrator`). Files older than data
  version 15 open with a warning and are only written when you click Save.
- Font dialog, keyboard switching (desktop-only features).
- Firefox and Safari, which lack the File System Access API.

## XSLT engine

This uses the browser's built-in `XSLTProcessor` (libxslt in Edge/Chrome). Chromium has
announced plans to remove built-in XSLT, so `js/xslt.js` is the only file that touches the
engine; it can be replaced with SaxonJS without changing the rest.

## Self-test

`test/selftest.html` loads all page descriptions and generates grammars from two sample
files; `test/compare_selftest.py` checks the results against lxml:

```
msedge --headless=new --virtual-time-budget=120000 --dump-dom http://localhost:8080/test/selftest.html > dump.html
python web/test/compare_selftest.py dump.html
```
