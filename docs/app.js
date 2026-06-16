// === Konfigurace ===
const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-8";
const MAX_LONG_EDGE = 1568; // px — delší hrana fotky
const KEY_STORAGE = "anthropic_api_key";

const SYSTEM_PROMPT = `Jsi expert na výživu a analýzu jídla z fotografií. Tvým úkolem je z přiložené
fotografie identifikovat jídlo a odhadnout jeho kalorickou a nutriční hodnotu.
Pokud uživatel poskytne upřesnění, máš ho přednostně použít.

VSTUPY (vše je součástí uživatelské zprávy):
- Fotografie jídla (povinné).
- Volitelné upřesnění uživatele (např. "kuřecí prsa, 150 g", "bez dresinku").

POSTUP:
1. Identifikuj všechny pokrmy a ingredience viditelné na fotografii.
2. Pokud uživatel dodal upřesnění, použij ho jako PRIORITNÍ zdroj pravdy:
   - Uvedenou gramáž, název nebo složku ber jako danou (jistota = "vysoká", zdroj = "upřesnění").
   - Odeber nebo přidej složky podle pokynu (např. "bez dresinku").
   - Zbytek jídla dál odhaduj z fotografie (zdroj = "fotografie").
3. Odhadni velikost neupřesněných porcí pomocí vizuálních referenčních bodů
   (talíř ~26 cm, příbor, ruka, sklenice apod.).
4. Pro každou položku vypočítej nutriční hodnoty a sečti je do pole "celkem".

PRAVIDLA:
- Upřesnění od uživatele má vždy přednost před odhadem z fotografie.
- Pokud uživatelská zpráva žádné upřesnění neobsahuje, nastav "pouzite_upresneni": false.
- Pokud bylo upřesnění použito, nastav "pouzite_upresneni": true.
- Pokud upřesnění odporuje fotografii, drž se upřesnění, ale zmiň rozpor v "poznamka".
- U skrytých složek (olej, máslo, cukr, dresink) připočítej realistický odhad,
  pokud je uživatel výslovně nevyloučil.
- Hodnoty zaokrouhluj na celá čísla.
- Pokud fotografie neobsahuje jídlo, vrať prázdné pole "polozky" a vysvětli to v "poznamka".
- Veškeré textové hodnoty piš v češtině.`;

// JSON schéma pro structured outputs (zrcadlí požadovaný tvar)
const JISTOTA_ENUM = ["vysoká", "střední", "nízká"];
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    polozky: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          nazev: { type: "string" },
          odhad_gramaze_g: { type: "integer" },
          kalorie_kcal: { type: "integer" },
          bilkoviny_g: { type: "integer" },
          sacharidy_g: { type: "integer" },
          tuky_g: { type: "integer" },
          jistota: { type: "string", enum: JISTOTA_ENUM },
          zdroj: { type: "string", enum: ["fotografie", "upřesnění"] },
        },
        required: [
          "nazev",
          "odhad_gramaze_g",
          "kalorie_kcal",
          "bilkoviny_g",
          "sacharidy_g",
          "tuky_g",
          "jistota",
          "zdroj",
        ],
      },
    },
    celkem: {
      type: "object",
      additionalProperties: false,
      properties: {
        kalorie_kcal: { type: "integer" },
        bilkoviny_g: { type: "integer" },
        sacharidy_g: { type: "integer" },
        tuky_g: { type: "integer" },
      },
      required: ["kalorie_kcal", "bilkoviny_g", "sacharidy_g", "tuky_g"],
    },
    pouzite_upresneni: { type: "boolean" },
    poznamka: { type: "string" },
    celkova_jistota: { type: "string", enum: JISTOTA_ENUM },
  },
  required: [
    "polozky",
    "celkem",
    "pouzite_upresneni",
    "poznamka",
    "celkova_jistota",
  ],
};

// === DOM ===
const form = document.getElementById("form");
const cameraInput = document.getElementById("camera");
const galleryInput = document.getElementById("gallery");
const cameraBtn = document.getElementById("cameraBtn");
const galleryBtn = document.getElementById("galleryBtn");
const preview = document.getElementById("preview");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const submitBtn = document.getElementById("submit");
const upresneniEl = document.getElementById("upresneni");
const settings = document.getElementById("settings");
const apiKeyEl = document.getElementById("apiKey");
const saveKeyBtn = document.getElementById("saveKey");
const keyStatus = document.getElementById("keyStatus");

const JISTOTA_CLASS = { vysoká: "high", střední: "mid", nízká: "low" };

let selectedFile = null;

// === Klíč ===
function getKey() {
  return (localStorage.getItem(KEY_STORAGE) || "").trim();
}

function refreshKeyStatus() {
  const key = getKey();
  if (key) {
    keyStatus.textContent = "✓ Klíč uložen v tomhle prohlížeči.";
    keyStatus.className = "keystatus ok";
    apiKeyEl.value = key;
  } else {
    keyStatus.textContent = "Klíč zatím není uložen.";
    keyStatus.className = "keystatus";
    settings.open = true;
  }
}

saveKeyBtn.addEventListener("click", () => {
  const key = apiKeyEl.value.trim();
  if (!key) {
    keyStatus.textContent = "Zadej klíč.";
    keyStatus.className = "keystatus err";
    return;
  }
  localStorage.setItem(KEY_STORAGE, key);
  refreshKeyStatus();
  settings.open = false;
});

refreshKeyStatus();

// === Výběr fotky ===
cameraBtn.addEventListener("click", () => cameraInput.click());
galleryBtn.addEventListener("click", () => galleryInput.click());

[cameraInput, galleryInput].forEach((input) =>
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (!file) return;
    selectedFile = file;
    preview.src = URL.createObjectURL(file);
    preview.hidden = false;
    submitBtn.disabled = false;
    clearStatus();
    resultsEl.hidden = true;
  })
);

// === Zmenšení fotky v prohlížeči → base64 JPEG ===
async function loadBitmap(file) {
  // createImageBitmap s 'from-image' respektuje EXIF rotaci (fotky z telefonu)
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (_) {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Obrázek nelze načíst."));
      img.src = URL.createObjectURL(file);
    });
  }
}

async function imageToBase64(file) {
  const bitmap = await loadBitmap(file);
  const sw = bitmap.width;
  const sh = bitmap.height;
  const longest = Math.max(sw, sh);
  const scale = longest > MAX_LONG_EDGE ? MAX_LONG_EDGE / longest : 1;
  const w = Math.round(sw * scale);
  const h = Math.round(sh * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, h);

  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  return dataUrl.split(",")[1]; // ořízne "data:image/jpeg;base64,"
}

// === Analýza ===
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedFile) return;

  const key = getKey();
  if (!key) {
    setStatus("Nejdřív ulož API klíč (sekce 🔑 nahoře).", "error");
    settings.open = true;
    return;
  }

  setStatus("Analyzuji fotografii… (může to chvíli trvat)", "loading");
  resultsEl.hidden = true;
  submitBtn.disabled = true;

  try {
    const b64 = await imageToBase64(selectedFile);

    const upresneni = upresneniEl.value.trim();
    const userText = upresneni
      ? `UPŘESNĚNÍ UŽIVATELE:\n${upresneni}`
      : 'Uživatel nedodal žádné upřesnění. Pracuj jen z fotografie a nastav "pouzite_upresneni": false.';

    const body = {
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      thinking: { type: "adaptive" },
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: b64 },
            },
            { type: "text", text: userText },
          ],
        },
      ],
    };

    let resp;
    try {
      resp = await fetch(API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify(body),
      });
    } catch (netErr) {
      throw new Error(
        "Nepodařilo se spojit s Anthropic API (síť nebo CORS). Zkontroluj připojení."
      );
    }

    const json = await resp.json();
    if (!resp.ok) {
      throw new Error(
        (json && json.error && json.error.message) || `HTTP ${resp.status}`
      );
    }
    if (json.stop_reason === "refusal") {
      throw new Error("Model odmítl požadavek zpracovat (bezpečnostní důvody).");
    }
    if (json.stop_reason === "max_tokens") {
      throw new Error("Odpověď se nedokončila (limit tokenů). Zkus to znovu.");
    }

    const textBlock = (json.content || []).find((b) => b.type === "text");
    if (!textBlock) throw new Error("Model nevrátil textovou odpověď.");

    let data;
    try {
      data = JSON.parse(textBlock.text);
    } catch (_) {
      throw new Error("Odpověď modelu nešla přečíst jako JSON.");
    }

    renderResults(data);
    clearStatus();
  } catch (err) {
    setStatus("Chyba: " + err.message, "error");
  } finally {
    submitBtn.disabled = false;
  }
});

// === UI helpery ===
function setStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.className = "status " + (kind || "");
  statusEl.hidden = false;
}

function clearStatus() {
  statusEl.hidden = true;
}

function badge(jistota) {
  return `<span class="badge ${JISTOTA_CLASS[jistota] || ""}">${escapeHtml(
    jistota
  )}</span>`;
}

function renderResults(data) {
  const c = data.celkem || {};
  let html = `
    <div class="totals">
      <div><span>Kalorie</span><strong>${c.kalorie_kcal ?? 0} kcal</strong></div>
      <div><span>Bílkoviny</span><strong>${c.bilkoviny_g ?? 0} g</strong></div>
      <div><span>Sacharidy</span><strong>${c.sacharidy_g ?? 0} g</strong></div>
      <div><span>Tuky</span><strong>${c.tuky_g ?? 0} g</strong></div>
    </div>`;

  if (!data.polozky || data.polozky.length === 0) {
    html += `<p class="empty">Na fotografii nebylo rozpoznáno žádné jídlo.</p>`;
  } else {
    const rows = data.polozky
      .map(
        (p) => `
        <tr>
          <td data-label="">${escapeHtml(p.nazev)}</td>
          <td data-label="Gramáž (g)" class="num">${p.odhad_gramaze_g}</td>
          <td data-label="Kalorie (kcal)" class="num">${p.kalorie_kcal}</td>
          <td data-label="Bílkoviny (g)" class="num">${p.bilkoviny_g}</td>
          <td data-label="Sacharidy (g)" class="num">${p.sacharidy_g}</td>
          <td data-label="Tuky (g)" class="num">${p.tuky_g}</td>
          <td data-label="Jistota">${badge(p.jistota)}</td>
          <td data-label="Zdroj">${escapeHtml(p.zdroj)}</td>
        </tr>`
      )
      .join("");

    html += `
      <table>
        <thead>
          <tr>
            <th>Položka</th><th class="num">g</th><th class="num">kcal</th>
            <th class="num">B&nbsp;(g)</th><th class="num">S&nbsp;(g)</th>
            <th class="num">T&nbsp;(g)</th><th>Jistota</th><th>Zdroj</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  html += `
    <dl class="meta">
      <div><dt>Použité upřesnění</dt><dd>${
        data.pouzite_upresneni ? "ano" : "ne"
      }</dd></div>
      <div><dt>Celková jistota</dt><dd>${badge(data.celkova_jistota)}</dd></div>
    </dl>`;

  if (data.poznamka) {
    html += `<p class="poznamka">📝 ${escapeHtml(data.poznamka)}</p>`;
  }

  resultsEl.innerHTML = html;
  resultsEl.hidden = false;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        ch
      ])
  );
}
