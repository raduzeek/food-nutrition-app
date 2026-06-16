"""Vygeneruje ikony aplikace (home-screen / PWA) pomocí Pillow.

Spuštění:  python tools/make_icons.py
Vytvoří:   static/icon-180.png, icon-192.png, icon-512.png
"""

from pathlib import Path

from PIL import Image, ImageDraw

ACCENT = (196, 98, 45)  # #c4622d
PLATE = (255, 255, 255)
FOOD = (232, 181, 75)  # teplá žlutá
FOOD2 = (122, 160, 90)  # tlumená zelená

STATIC = Path(__file__).resolve().parent.parent / "static"
SIZES = {"icon-180.png": 180, "icon-192.png": 192, "icon-512.png": 512}


def render(size: int) -> Image.Image:
    """Vykreslí ikonu ve vysokém rozlišení a zmenší na cílovou velikost."""
    s = size * 4
    img = Image.new("RGB", (s, s), ACCENT)
    d = ImageDraw.Draw(img)
    cx = cy = s / 2

    # talíř (bílý kruh)
    pr = s * 0.34
    d.ellipse([cx - pr, cy - pr, cx + pr, cy + pr], fill=PLATE)

    # jídlo na talíři (dva překrývající se kruhy)
    fr = s * 0.17
    d.ellipse(
        [cx - fr * 1.4, cy - fr, cx + fr * 0.2, cy + fr], fill=FOOD
    )
    d.ellipse(
        [cx - fr * 0.2, cy - fr * 0.7, cx + fr * 1.4, cy + fr * 1.1], fill=FOOD2
    )

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    for name, size in SIZES.items():
        render(size).save(STATIC / name)
        print("napsáno", STATIC / name)


if __name__ == "__main__":
    main()
