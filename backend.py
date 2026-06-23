"""Data access layer for the Document Parsing comparison app.

Reads the `ai_parse_document` output from a Unity Catalog table and the source
TIFF faxes from a UC Volume, converting each TIFF page to a browser-friendly PNG.

On Databricks Apps, authentication is handled automatically via the injected
service-principal credentials (`Config()` / `WorkspaceClient()`). Locally, it
falls back to your `DATABRICKS_CONFIG_PROFILE`.

TIFF -> PNG conversion uses Pillow (with bundled libtiff for CCITT G4). When
Pillow is unavailable (e.g. local dev without network access to PyPI) it falls
back to the macOS `sips` tool so the app can still be exercised end-to-end.
"""

from __future__ import annotations

import io
import json
import os
import struct
import subprocess
import tempfile
import threading
import time
from typing import Any

SOURCE_TABLE = os.getenv(
    "SOURCE_TABLE",
    "srikar_demo_workspace_catalog.fax_transcription_sutter.dummy_raw",
)
# DATABRICKS_WAREHOUSE_ID is injected by the `sql-warehouse` app resource.
WAREHOUSE_ID = os.getenv("DATABRICKS_WAREHOUSE_ID", "")


def _doc_id_from_path(path: str) -> str:
    """`dbfs:/Volumes/.../fax_0001.tif` -> `fax_0001`."""
    name = path.rstrip("/").split("/")[-1]
    return name.rsplit(".", 1)[0]


def _volume_path(path: str) -> str:
    """Strip the `dbfs:` scheme so the Files API can read the UC Volume path."""
    if path.startswith("dbfs:"):
        return path[len("dbfs:"):]
    return path


def _png_dimensions(png: bytes) -> tuple[int, int]:
    """Read width/height from a PNG IHDR chunk (no image library needed)."""
    # 8-byte signature, 4-byte length, 4-byte "IHDR", then width/height (uint32 BE).
    width, height = struct.unpack(">II", png[16:24])
    return width, height


class Backend:
    def __init__(self) -> None:
        self._client = None
        self._docs: list[dict[str, Any]] | None = None
        self._docs_by_id: dict[str, dict[str, Any]] = {}
        self._render_cache: dict[tuple[str, int], tuple[bytes, int, int]] = {}
        self._lock = threading.Lock()

    # -- Databricks clients ------------------------------------------------
    @property
    def client(self):
        if self._client is None:
            from databricks.sdk import WorkspaceClient  # lazy: not needed for local tests

            self._client = WorkspaceClient()
        return self._client

    # -- Parsed document metadata -----------------------------------------
    def _exec(self, statement: str, parameters: list | None = None):
        if not WAREHOUSE_ID:
            raise RuntimeError(
                "DATABRICKS_WAREHOUSE_ID is not set. Bind a SQL warehouse "
                "resource (key `sql-warehouse`) to the app."
            )
        kwargs: dict[str, Any] = dict(
            warehouse_id=WAREHOUSE_ID, statement=statement, wait_timeout="50s"
        )
        if parameters:
            kwargs["parameters"] = parameters
        resp = self.client.statement_execution.execute_statement(**kwargs)
        # Poll if the warehouse was cold and the statement is still running.
        statement_id = resp.statement_id
        deadline = time.time() + 120
        while resp.status and resp.status.state and resp.status.state.value in (
            "PENDING",
            "RUNNING",
        ):
            if time.time() > deadline:
                raise TimeoutError("SQL statement timed out")
            time.sleep(1.5)
            resp = self.client.statement_execution.get_statement(statement_id)

        state = resp.status.state.value if resp.status and resp.status.state else "?"
        if state != "SUCCEEDED":
            msg = ""
            if resp.status and resp.status.error:
                msg = resp.status.error.message or ""
            raise RuntimeError(f"SQL statement {state}: {msg}")
        return resp

    def _run_query(self, statement: str) -> list[list[Any]]:
        resp = self._exec(statement)
        if not resp.result or not resp.result.data_array:
            return []
        return resp.result.data_array

    def _persist(self, path: str, parsed_json: str) -> None:
        """Write the full (edited) parsed JSON back to the table's VARIANT column."""
        from databricks.sdk.service.sql import StatementParameterListItem

        self._exec(
            f"UPDATE {SOURCE_TABLE} SET parsed = PARSE_JSON(:parsed) WHERE path = :path",
            parameters=[
                StatementParameterListItem(name="parsed", value=parsed_json),
                StatementParameterListItem(name="path", value=path),
            ],
        )

    def _build_doc(self, path: str, parsed_json: str) -> dict[str, Any]:
        parsed = json.loads(parsed_json)
        document = parsed.get("document", {}) or {}
        raw_elements = document.get("elements", []) or []
        raw_pages = document.get("pages", []) or []

        # Ordered content list for the formatted / JSON panes.
        elements: list[dict[str, Any]] = []
        # Per-page overlay boxes.
        boxes_by_page: dict[int, list[dict[str, Any]]] = {}

        for el in raw_elements:
            el_id = el.get("id")
            el_type = el.get("type") or "text"
            content = el.get("content") or ""
            confidence = el.get("confidence")
            bboxes = el.get("bbox") or []
            first_page = bboxes[0].get("page_id", 0) if bboxes else 0
            elements.append(
                {
                    "id": el_id,
                    "type": el_type,
                    "content": content,
                    "confidence": confidence,
                    "page": first_page,
                }
            )
            for b in bboxes:
                page_id = b.get("page_id", 0)
                coord = b.get("coord")
                if not coord:
                    continue
                boxes_by_page.setdefault(page_id, []).append(
                    {
                        "id": el_id,
                        "type": el_type,
                        "coord": coord,  # [x1, y1, x2, y2] in source-image pixels
                        "confidence": confidence,
                    }
                )

        page_ids = sorted({p.get("id", i) for i, p in enumerate(raw_pages)} | set(boxes_by_page))
        if not page_ids:
            page_ids = [0]

        type_counts: dict[str, int] = {}
        for el in elements:
            type_counts[el["type"]] = type_counts.get(el["type"], 0) + 1

        doc_id = _doc_id_from_path(path)
        return {
            "id": doc_id,
            "name": path.rstrip("/").split("/")[-1],
            "path": path,
            "volume_path": _volume_path(path),
            "page_ids": page_ids,
            "page_count": len(page_ids),
            "element_count": len(elements),
            "type_counts": type_counts,
            "elements": elements,
            "boxes_by_page": boxes_by_page,
            "parsed": parsed,  # full ai_parse_document JSON, mutated + persisted on edit
        }

    def load(self, force: bool = False) -> list[dict[str, Any]]:
        with self._lock:
            if self._docs is not None and not force:
                return self._docs
            rows = self._run_query(
                f"SELECT path, CAST(parsed AS STRING) AS parsed_json "
                f"FROM {SOURCE_TABLE} ORDER BY path"
            )
            docs = [self._build_doc(path, pj) for path, pj in rows]
            self._docs = docs
            self._docs_by_id = {d["id"]: d for d in docs}
            if force:
                self._render_cache.clear()
            return docs

    def list_documents(self) -> list[dict[str, Any]]:
        docs = self.load()
        return [
            {
                "id": d["id"],
                "name": d["name"],
                "page_count": d["page_count"],
                "element_count": d["element_count"],
                "type_counts": d["type_counts"],
            }
            for d in docs
        ]

    def get_document(self, doc_id: str) -> dict[str, Any] | None:
        self.load()
        doc = self._docs_by_id.get(doc_id)
        if not doc:
            return None
        pages = []
        for page_id in doc["page_ids"]:
            _png, width, height = self._render(doc_id, page_id)
            pages.append(
                {
                    "page_id": page_id,
                    "width": width,
                    "height": height,
                    "boxes": doc["boxes_by_page"].get(page_id, []),
                }
            )
        return {
            "id": doc["id"],
            "name": doc["name"],
            "path": doc["path"],
            "pages": pages,
            "elements": doc["elements"],
        }

    def update_element(self, doc_id: str, element_id: int, new_content: str) -> dict[str, Any]:
        """Set an element's `content`, persist the whole row's parsed JSON, update cache."""
        self.load()
        doc = self._docs_by_id.get(doc_id)
        if not doc:
            raise KeyError(f"Unknown document: {doc_id}")
        elements = (doc["parsed"].get("document") or {}).get("elements") or []
        target = next((e for e in elements if e.get("id") == element_id), None)
        if target is None:
            raise KeyError(f"Unknown element {element_id} in {doc_id}")

        with self._lock:
            target["content"] = new_content
            # Persist the full parsed JSON back to the VARIANT column.
            self._persist(doc["path"], json.dumps(doc["parsed"]))
            # Keep the processed cache (served by the API) consistent.
            for e in doc["elements"]:
                if e["id"] == element_id:
                    e["content"] = new_content
                    break
        return {
            "id": element_id,
            "type": target.get("type"),
            "content": new_content,
            "confidence": target.get("confidence"),
        }

    # -- Image rendering ---------------------------------------------------
    def get_page_image(self, doc_id: str, page: int) -> bytes | None:
        self.load()
        if doc_id not in self._docs_by_id:
            return None
        png, _w, _h = self._render(doc_id, page)
        return png

    def _render(self, doc_id: str, page: int) -> tuple[bytes, int, int]:
        key = (doc_id, page)
        cached = self._render_cache.get(key)
        if cached:
            return cached
        with self._lock:
            cached = self._render_cache.get(key)
            if cached:
                return cached
            doc = self._docs_by_id[doc_id]
            tiff_bytes = self.client.files.download(doc["volume_path"]).contents.read()
            result = _tiff_to_png(tiff_bytes, page)
            self._render_cache[key] = result
            return result


def _tiff_to_png(tiff_bytes: bytes, page: int = 0) -> tuple[bytes, int, int]:
    """Convert one page of a (possibly multi-page) TIFF to PNG bytes + dimensions."""
    try:
        from PIL import Image  # type: ignore

        im = Image.open(io.BytesIO(tiff_bytes))
        try:
            im.seek(page)
        except EOFError:
            im.seek(0)
        rgb = im.convert("RGB")
        buf = io.BytesIO()
        rgb.save(buf, format="PNG", optimize=True)
        return buf.getvalue(), rgb.width, rgb.height
    except ImportError:
        return _tiff_to_png_sips(tiff_bytes)


def _tiff_to_png_sips(tiff_bytes: bytes) -> tuple[bytes, int, int]:
    """Local-dev fallback: convert via the macOS `sips` tool (page 0 only)."""
    with tempfile.NamedTemporaryFile(suffix=".tif", delete=False) as tf:
        tf.write(tiff_bytes)
        tif_path = tf.name
    png_path = tif_path + ".png"
    try:
        subprocess.run(
            ["sips", "-s", "format", "png", tif_path, "--out", png_path],
            check=True,
            capture_output=True,
        )
        with open(png_path, "rb") as fh:
            png = fh.read()
        width, height = _png_dimensions(png)
        return png, width, height
    finally:
        for p in (tif_path, png_path):
            try:
                os.unlink(p)
            except OSError:
                pass


backend = Backend()
