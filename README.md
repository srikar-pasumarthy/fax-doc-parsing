# Document Parsing — Fax TIFF vs. Extracted Text

A Databricks App that puts each raw fax **TIFF** side-by-side with the
**`ai_parse_document`** output: bounding boxes overlaid on the page (colored by
element type) on the left, and the extracted, formatted text on the right.

## Data sources
- **Images**: TIFFs in the UC Volume `/Volumes/srikar_demo_workspace_catalog/fax_transcription_sutter/faxes/tiff/`
- **Parsed text**: `srikar_demo_workspace_catalog.fax_transcription_sutter.dummy_raw`
  (`path` STRING, `parsed` VARIANT — the `ai_parse_document` result)

## How it works
- `backend.py` — queries the table via the SQL warehouse (Statement Execution API),
  downloads each TIFF from the Volume (Files API), and converts it to PNG with
  Pillow (CCITT G4 fax compression supported via bundled libtiff). Results are cached.
  Edits patch the element's `content` in the row's parsed JSON and write the whole
  value back with `UPDATE … SET parsed = PARSE_JSON(:parsed) WHERE path = :path`.
- `app.py` — FastAPI app exposing `/api/documents`, `/api/documents/{id}`,
  `/api/documents/{id}/pages/{p}/image.png`, `PUT /api/documents/{id}/elements/{eid}`,
  and the static UI.
- `static/` — single-page UI: bounding-box overlay (positioned as % of the source
  image so it scales), bidirectional hover/click linking between boxes and text,
  per-type legend, search with highlighting, Formatted/JSON views, page nav, zoom,
  and inline editing.

## Features
- Hover a box → the matching text highlights (and vice-versa); click to pin.
- Legend with per-document element-type counts.
- Search highlights matches (including inside tables) and dims the rest.
- Formatted view renders titles/headers/tables (with checkboxes); JSON view shows
  the raw parsed elements.
- **Edit & correct** — toggle Edit mode to fix parse errors inline (text fields and
  individual table cells). Changes auto-save on blur (Enter commits single-line
  fields, Esc reverts) and persist back to the `parsed` VARIANT column in the table.

## Configuration (`app.yaml`)
- `DATABRICKS_WAREHOUSE_ID` ← bound `sql-warehouse` resource.
- `SOURCE_TABLE` ← the parsed-output table.

The app's service principal needs `USE CATALOG`/`USE SCHEMA`, `SELECT` and
`MODIFY` (for saving edits) on the table, and `READ VOLUME` on the volume.

## Local development
TIFF conversion falls back to macOS `sips` when Pillow is unavailable, and
`_scratch/mockserver.py` serves the real UI against a local fixture for offline
iteration.

## Deploy
```bash
databricks workspace import-dir . /Workspace/Users/<you>/apps/fax-doc-parsing --overwrite
databricks apps deploy fax-doc-parsing \
  --source-code-path /Workspace/Users/<you>/apps/fax-doc-parsing
```
