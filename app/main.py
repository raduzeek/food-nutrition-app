"""FastAPI aplikace: endpoint /analyze + servírování statického frontendu."""

from pathlib import Path

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .nutrition import AnalysisError, analyze

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Analýza jídla z fotky")


@app.post("/analyze")
async def analyze_endpoint(
    photo: UploadFile = File(...),
    upresneni: str = Form(""),
):
    image_bytes = await photo.read()
    if not image_bytes:
        return JSONResponse(
            status_code=400, content={"error": "Nebyl nahrán žádný soubor."}
        )
    try:
        vysledek = analyze(image_bytes, photo.content_type or "", upresneni)
    except AnalysisError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    return JSONResponse(content=vysledek.model_dump())


# Statický frontend na kořeni "/" (musí být až za API routami).
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
