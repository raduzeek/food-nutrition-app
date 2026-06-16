"""Volání Claude API: z bajtů obrázku + volitelného upřesnění udělá Analyzu."""

import base64
import io
import os
from typing import Optional

import anthropic
from PIL import Image, ImageOps

from .prompt import SYSTEM_PROMPT
from .schema import Analyza

# Volitelná podpora HEIC/HEIF (formát fotek z iPhonu). Safari sice při uploadu
# přes <input type=file> obvykle převede na JPEG, ale tohle je pojistka navíc.
try:
    from pillow_heif import register_heif_opener

    register_heif_opener()
except Exception:  # pragma: no cover - knihovna nemusí být nainstalovaná
    pass

MODEL = "claude-opus-4-8"
MAX_LONG_EDGE = 1568  # px — zmenšíme delší hranu kvůli velikosti vstupu a nákladům

# Klient se vytváří líně, aby server nastartoval i bez klíče a dal jasnou hlášku.
_client: "anthropic.Anthropic | None" = None


class AnalysisError(Exception):
    """Chyba, kterou chceme srozumitelně ukázat uživateli."""


def _get_client() -> anthropic.Anthropic:
    """Vrátí Anthropic klienta; klíč čte z prostředí (ANTHROPIC_API_KEY)."""
    global _client
    if _client is None:
        # Klient bez klíče se v SDK vytvoří, ale spadne až při volání requestu.
        # Zkontrolujeme proaktivně, ať dostaneme srozumitelnou hlášku dřív.
        if not (
            os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")
        ):
            raise AnalysisError(
                "Chybí ANTHROPIC_API_KEY. Nastav proměnnou prostředí a "
                "restartuj server."
            )
        _client = anthropic.Anthropic()
    return _client


def _prepare_image(image_bytes: bytes) -> tuple[str, str]:
    """Načte, (volitelně) zmenší obrázek a vrátí (base64_data, media_type)."""
    try:
        img = Image.open(io.BytesIO(image_bytes))
        img.load()
    except Exception as exc:  # nečitelný nebo nepodporovaný soubor
        raise AnalysisError("Soubor se nepodařilo načíst jako obrázek.") from exc

    # Telefony ukládají rotaci do EXIFu — narovnáme obrázek, ať není na boku.
    img = ImageOps.exif_transpose(img)

    # Sjednotíme na RGB JPEG — zjednoduší media_type a zmenší velikost.
    img = img.convert("RGB")

    width, height = img.size
    longest = max(width, height)
    if longest > MAX_LONG_EDGE:
        scale = MAX_LONG_EDGE / longest
        img = img.resize((round(width * scale), round(height * scale)))

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    data = base64.standard_b64encode(buf.getvalue()).decode("utf-8")
    return data, "image/jpeg"


def analyze(image_bytes: bytes, media_type: str, upresneni: Optional[str]) -> Analyza:
    """Pošle fotku (a volitelné upřesnění) Claude a vrátí validovanou Analyzu."""
    data, out_media_type = _prepare_image(image_bytes)

    upresneni = (upresneni or "").strip()
    if upresneni:
        user_text = f"UPŘESNĚNÍ UŽIVATELE:\n{upresneni}"
    else:
        user_text = (
            "Uživatel nedodal žádné upřesnění. Pracuj jen z fotografie a nastav "
            '"pouzite_upresneni": false.'
        )

    try:
        response = _get_client().messages.parse(
            model=MODEL,
            max_tokens=2000,
            system=SYSTEM_PROMPT,
            thinking={"type": "adaptive"},
            output_format=Analyza,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": out_media_type,
                                "data": data,
                            },
                        },
                        {"type": "text", "text": user_text},
                    ],
                }
            ],
        )
    except anthropic.APIError as exc:
        raise AnalysisError(f"Chyba při volání Claude API: {exc}") from exc

    if response.stop_reason == "refusal":
        raise AnalysisError("Model odmítl požadavek zpracovat (bezpečnostní důvody).")
    if response.stop_reason == "max_tokens":
        raise AnalysisError("Odpověď se nedokončila (limit tokenů). Zkuste to znovu.")

    result = response.parsed_output
    if result is None:
        raise AnalysisError("Nepodařilo se získat strukturovanou odpověď modelu.")
    return result
