"""Pydantic schéma výstupu — zrcadlí požadovaný JSON formát.

Používá se pro structured outputs (client.messages.parse), takže model je nucen
vrátit přesně tento tvar. Číselné hodnoty jsou celá čísla (pravidlo zaokrouhlení).
"""

from typing import Literal

from pydantic import BaseModel

Jistota = Literal["vysoká", "střední", "nízká"]
Zdroj = Literal["fotografie", "upřesnění"]


class Polozka(BaseModel):
    nazev: str
    odhad_gramaze_g: int
    kalorie_kcal: int
    bilkoviny_g: int
    sacharidy_g: int
    tuky_g: int
    jistota: Jistota
    zdroj: Zdroj


class Celkem(BaseModel):
    kalorie_kcal: int
    bilkoviny_g: int
    sacharidy_g: int
    tuky_g: int


class Analyza(BaseModel):
    polozky: list[Polozka]
    celkem: Celkem
    pouzite_upresneni: bool
    poznamka: str
    celkova_jistota: Jistota
