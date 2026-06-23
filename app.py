"""Document Parsing comparison app.

Side-by-side viewer comparing raw fax TIFFs (with bounding-box overlays from
`ai_parse_document`) against the extracted, formatted text.
"""

from __future__ import annotations

import os
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend import SOURCE_TABLE, backend


class ElementUpdate(BaseModel):
    content: str

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")


def _warm_and_selftest() -> None:
    """Exercise the full data path (warehouse -> Volume -> Pillow) once on startup.
    Warms the cache for the first user and logs a clear status to the app logs."""
    try:
        docs = backend.list_documents()
        print(f"[selftest] loaded {len(docs)} documents from {SOURCE_TABLE}", flush=True)
        if docs:
            doc = backend.get_document(docs[0]["id"])
            pg = doc["pages"][0]
            print(
                f"[selftest] rendered {doc['name']} page {pg['page_id']} -> "
                f"{pg['width']}x{pg['height']}px, {len(pg['boxes'])} boxes",
                flush=True,
            )
        print("[selftest] OK - warehouse query + Volume download + image render all working", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[selftest] FAILED: {type(exc).__name__}: {exc}", flush=True)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    threading.Thread(target=_warm_and_selftest, daemon=True).start()
    yield


app = FastAPI(title="Document Parsing", docs_url=None, redoc_url=None, lifespan=lifespan)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/config")
def get_config() -> dict[str, str]:
    return {"source_table": SOURCE_TABLE}


@app.get("/api/documents")
def list_documents(refresh: bool = False):
    try:
        if refresh:
            backend.load(force=True)
        return backend.list_documents()
    except Exception as exc:  # surface a readable error to the UI
        raise HTTPException(status_code=503, detail=str(exc))


@app.get("/api/documents/{doc_id}")
def get_document(doc_id: str):
    try:
        doc = backend.get_document(doc_id)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    if doc is None:
        raise HTTPException(status_code=404, detail=f"Unknown document: {doc_id}")
    return doc


@app.put("/api/documents/{doc_id}/elements/{element_id}")
def update_element(doc_id: str, element_id: int, body: ElementUpdate):
    try:
        return backend.update_element(doc_id, element_id, body.content)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@app.get("/api/documents/{doc_id}/pages/{page}/image.png")
def get_page_image(doc_id: str, page: int):
    try:
        png = backend.get_page_image(doc_id, page)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    if png is None:
        raise HTTPException(status_code=404, detail="Image not found")
    return Response(
        content=png,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


# Static assets (styles.css, app.js, ...) served from /static.
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
