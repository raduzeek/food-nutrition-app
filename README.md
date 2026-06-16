# Analýza jídla z fotky

Aplikace, která z fotografie jídla odhadne kalorie a makroživiny pomocí Claude
(model `claude-opus-4-8`, vision + structured outputs).

Jsou tu **dvě varianty**:

| Varianta | Kde | Kdy ji použít |
| --- | --- | --- |
| **Serverová** (`app/`) | FastAPI běží na Macu/serveru | Klíč zůstává bezpečně na serveru. Vyžaduje běžící backend. |
| **Bez serveru** (`docs/`) | Statická stránka, počítá prohlížeč | „Běží v telefonu" — volá Claude přímo z prohlížeče, klíč jen v telefonu. Lze hostovat zdarma (GitHub Pages). Viz [§ Verze bez serveru](#verze-bez-serveru-bě-v-prohlí). |

---

## Spuštění (serverová verze)

1. Nastav API klíč:
   ```bash
   export ANTHROPIC_API_KEY="sk-ant-..."
   ```
2. Vytvoř virtuální prostředí a nainstaluj závislosti:
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```
3. Spusť server:
   ```bash
   uvicorn app.main:app --reload
   ```
4. Otevři <http://127.0.0.1:8000>.

## Spuštění na iPhonu (focení jídla)

Aplikace je webová, takže na iPhonu poběží v Safari — stačí, aby byl telefon na
**stejné Wi-Fi** jako Mac a server poslouchal na všech rozhraních (ne jen na
localhostu).

1. V terminálu na Macu nastav klíč a spusť přiložený skript:
   ```bash
   export ANTHROPIC_API_KEY="sk-ant-..."
   ./run.sh
   ```
   Skript vypíše adresu pro telefon, např. `http://192.168.88.117:8000`.
   (`run.sh` jen spustí `uvicorn … --host 0.0.0.0`; ručně to jde i přes
   `uvicorn app.main:app --reload --host 0.0.0.0`.)
2. macOS se může poprvé zeptat na povolení příchozích spojení → **Povolit**.
3. Na iPhonu otevři v Safari vypsanou `http://<IP-Macu>:8000`.
4. Klepni na **📷 Vyfotit jídlo** → otevře se vestavěný foťák. Po vyfocení (a
   případném upřesnění) dej **Analyzovat**.
5. Volitelně: Safari → *Sdílet* → **Přidat na plochu** → appka se chová jako
   nativní (vlastní ikona, celá obrazovka).

> Server běží na HTTP po lokální síti — to pro nativní focení přes `<input
> capture>` stačí. (Živá kamera přes `getUserMedia` by na iOS vyžadovala HTTPS.)
> `--host 0.0.0.0` zpřístupní appku komukoli na té Wi-Fi; na domácí síti je to
> v pořádku, na cizí ji nech raději jen na `127.0.0.1`.

## Verze bez serveru (běží v prohlížeči)

Složka `docs/` je **samostatná statická aplikace** — žádný backend. Prohlížeč sám
zmenší fotku (canvas) a zavolá Claude API **přímo** (hlavička
`anthropic-dangerous-direct-browser-access`). Klíč zadáš jednou a uloží se jen
v `localStorage` daného prohlížeče — **není nikde v kódu**, takže stránku můžeš
hostovat veřejně.

> ⚠️ Klíč žije v prohlížeči a volá se z něj přímo — vhodné pro **osobní použití**.
> Nesdílej zařízení a klíč můžeš kdykoli zneplatnit v konzoli.

### Vyzkoušení lokálně (na Macu)

```bash
cd ~/food-nutrition-app
python3 -m http.server 8011 --directory docs
# otevři http://127.0.0.1:8011  (localhost je „secure context", volání API projde)
```

V appce rozbal **🔑 API klíč**, vlož svůj `sk-ant-...`, ulož a analyzuj.
(Neotevírej `index.html` přes `file://` — přímé volání API by narazilo na CORS.)

### Nasazení na iPhone přes GitHub Pages (zdarma, bez Macu)

1. Vytvoř repozitář na GitHubu a nahraj projekt:
   ```bash
   cd ~/food-nutrition-app
   git add -A && git commit -m "Kalorie z fotky"
   gh repo create food-nutrition-app --public --source=. --push
   # (nebo přes web GitHubu: nový repo → git remote add origin … → git push)
   ```
2. Na GitHubu: **Settings → Pages → Source: Deploy from a branch →
   Branch: `main`, složka `/docs` → Save**.
3. Za chvíli dostaneš URL typu `https://<jméno>.github.io/food-nutrition-app/`.
4. Tu otevři **v Safari na iPhonu** (https = funguje foťák i klíč), vlož klíč,
   *Sdílet → Přidat na plochu*. Hotovo — appka běží jen z telefonu, odkudkoli.

## Jak to funguje (serverová verze)

- **Frontend** (`static/`) pošle fotku + volitelné upřesnění na `POST /analyze`.
- **Backend** (`app/`) zmenší obrázek (Pillow), pošle ho Claude jako vision vstup
  spolu se system promptem (`app/prompt.py`) a vynutí strukturovaný JSON výstup
  podle schématu (`app/schema.py`).
- Vrácený JSON odpovídá polím `polozky` / `celkem` / `pouzite_upresneni` /
  `poznamka` / `celkova_jistota`.

## API

`POST /analyze` (multipart/form-data)

| Pole        | Typ     | Povinné | Popis                         |
| ----------- | ------- | ------- | ----------------------------- |
| `photo`     | soubor  | ano     | Obrázek jídla (jpg/png/webp…) |
| `upresneni` | text    | ne      | Upřesnění od uživatele        |

Vrací JSON dle schématu, nebo `{"error": "..."}` se stavovým kódem 400.

## Příklad (curl)

```bash
curl -F photo=@jidlo.jpg -F upresneni="kuřecí prsa 150 g, bez dresinku" \
  http://127.0.0.1:8000/analyze
```
