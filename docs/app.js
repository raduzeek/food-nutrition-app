// === Konfigurace ===
const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-8";
const MAX_LONG_EDGE = 1568; // px — delší hrana fotky pro analýzu
const KEY_STORAGE = "anthropic_api_key";
const MEALS_KEY = "meals_log_v1";
const GOAL_KEY = "daily_goal_kcal";
const CELKEM_FIELDS = ["kalorie_kcal", "bilkoviny_g", "sacharidy_g", "tuky_g"];

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
const goalEl = document.getElementById("goal");
const diaryBody = document.getElementById("diaryBody");
const exportCsvBtn = document.getElementById("exportCsv");
const exportJsonBtn = document.getElementById("exportJson");
const overviewBody = document.getElementById("overviewBody");
const periodTabs = document.querySelectorAll(".period-tab");
const customRange = document.getElementById("customRange");
const rangeFrom = document.getElementById("rangeFrom");
const rangeTo = document.getElementById("rangeTo");

const JISTOTA_CLASS = { vysoká: "high", střední: "mid", nízká: "low" };

let selectedFile = null;
let lastResult = null;
let lastFile = null;
let editingId = null;
let currentPeriod = "7";

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

// === Denní cíl ===
function getGoal() {
  const v = parseInt(localStorage.getItem(GOAL_KEY) || "", 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

goalEl.value = getGoal() || "";
goalEl.addEventListener("change", () => {
  const v = parseInt(goalEl.value, 10);
  if (Number.isFinite(v) && v > 0) localStorage.setItem(GOAL_KEY, String(v));
  else localStorage.removeItem(GOAL_KEY);
  refreshViews();
});

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

// === Práce s obrázkem ===
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
  const longest = Math.max(bitmap.width, bitmap.height);
  const scale = longest > MAX_LONG_EDGE ? MAX_LONG_EDGE / longest : 1;
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);

  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  return dataUrl.split(",")[1]; // ořízne "data:image/jpeg;base64,"
}

async function makeThumbnail(file, maxEdge = 160) {
  try {
    const bitmap = await loadBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = longest > maxEdge ? maxEdge / longest : 1;
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.7); // celý data URL pro <img>
  } catch (_) {
    return null;
  }
}

// === Analýza ===
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedFile) return;

  const key = getKey();
  if (!key) {
    setStatus("Nejdřív ulož API klíč (sekce ⚙️ Nastavení nahoře).", "error");
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

    lastResult = data;
    lastFile = selectedFile;
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

  html += `<button type="button" id="addMeal" class="big addmeal">➕ Přidat do deníku</button>`;

  resultsEl.innerHTML = html;
  resultsEl.hidden = false;

  const addBtn = document.getElementById("addMeal");
  addBtn.addEventListener("click", async () => {
    addBtn.disabled = true;
    addBtn.textContent = "Ukládám…";
    await addMealToDiary(lastResult, lastFile);
    addBtn.textContent = "✓ Přidáno do deníku";
  });
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

function escapeAttr(value) {
  return String(value).replace(
    /[&"<]/g,
    (ch) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;" }[ch])
  );
}

// === Deník jídel (localStorage) ===
function loadMeals() {
  try {
    return JSON.parse(localStorage.getItem(MEALS_KEY) || "[]");
  } catch (_) {
    return [];
  }
}

function saveMeals(meals) {
  localStorage.setItem(MEALS_KEY, JSON.stringify(meals));
}

function trySaveMeals(meals) {
  try {
    localStorage.setItem(MEALS_KEY, JSON.stringify(meals));
    return true;
  } catch (_) {
    return false; // typicky QuotaExceededError (plné úložiště)
  }
}

async function addMealToDiary(data, file) {
  if (!data) return;
  const thumb = file ? await makeThumbnail(file) : null;
  const nazev = (data.polozky || []).map((p) => p.nazev).join(", ") || "Jídlo";
  const meal = {
    id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
    ts: new Date().toISOString(),
    nazev,
    poznamka: "",
    celkem: data.celkem || {
      kalorie_kcal: 0,
      bilkoviny_g: 0,
      sacharidy_g: 0,
      tuky_g: 0,
    },
    polozky: data.polozky || [],
    thumb,
  };

  const meals = loadMeals();
  meals.push(meal);
  if (!trySaveMeals(meals)) {
    meal.thumb = null; // úložiště plné → zkus uložit bez miniatury
    if (trySaveMeals(meals)) {
      setStatus("Úložiště skoro plné — záznam uložen bez miniatury.", "error");
    } else {
      meals.pop();
      setStatus(
        "Úložiště telefonu je plné. Vyexportuj deník a smaž starší záznamy.",
        "error"
      );
      return;
    }
  }
  refreshViews();
}

function deleteMeal(id) {
  saveMeals(loadMeals().filter((m) => m.id !== id));
  refreshViews();
}

function dayKey(ts) {
  const d = new Date(ts);
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}

function fmtDay(key) {
  if (key === dayKey(new Date().toISOString())) return "Dnes";
  const [y, m, d] = key.split("-");
  return `${+d}. ${+m}. ${y}`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return (
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0")
  );
}

function mealRowHtml(m) {
  if (m.id === editingId) {
    return `
      <div class="meal editing">
        <div class="edit-grid">
          <label>Název<input type="text" class="ef" data-f="nazev" value="${escapeAttr(
            m.nazev
          )}" /></label>
          <label>Kalorie<input type="number" inputmode="numeric" class="ef" data-f="kalorie_kcal" value="${
            m.celkem.kalorie_kcal || 0
          }" /></label>
          <label>Bílkoviny (g)<input type="number" inputmode="numeric" class="ef" data-f="bilkoviny_g" value="${
            m.celkem.bilkoviny_g || 0
          }" /></label>
          <label>Sacharidy (g)<input type="number" inputmode="numeric" class="ef" data-f="sacharidy_g" value="${
            m.celkem.sacharidy_g || 0
          }" /></label>
          <label>Tuky (g)<input type="number" inputmode="numeric" class="ef" data-f="tuky_g" value="${
            m.celkem.tuky_g || 0
          }" /></label>
          <label class="wide">Poznámka<input type="text" class="ef" data-f="poznamka" value="${escapeAttr(
            m.poznamka || ""
          )}" /></label>
        </div>
        <div class="edit-actions">
          <button type="button" class="save" data-id="${m.id}">Uložit</button>
          <button type="button" class="ghost cancel">Zrušit</button>
        </div>
      </div>`;
  }

  const thumb = m.thumb
    ? `<img class="meal-thumb" src="${m.thumb}" alt="" />`
    : "";
  const note = m.poznamka
    ? `<div class="meal-note">${escapeHtml(m.poznamka)}</div>`
    : "";
  return `
    <div class="meal">
      ${thumb}
      <div class="meal-main">
        <div class="meal-line">
          <span class="meal-time">${fmtTime(m.ts)}</span>
          <span class="meal-name">${escapeHtml(m.nazev)}</span>
          <span class="meal-kcal">${m.celkem.kalorie_kcal || 0} kcal</span>
        </div>
        ${note}
      </div>
      <div class="meal-btns">
        <button type="button" class="edit" data-id="${m.id}" aria-label="Upravit">✎</button>
        <button type="button" class="del" data-id="${m.id}" aria-label="Smazat">✕</button>
      </div>
    </div>`;
}

function renderDiary() {
  const meals = loadMeals();
  if (meals.length === 0) {
    diaryBody.innerHTML =
      '<p class="empty">Zatím žádné záznamy. Po analýze klepni na „Přidat do deníku".</p>';
    return;
  }

  const goal = getGoal();
  const byDay = {};
  meals.forEach((m) => {
    const k = dayKey(m.ts);
    (byDay[k] = byDay[k] || []).push(m);
  });

  const days = Object.keys(byDay).sort().reverse();
  diaryBody.innerHTML = days
    .map((key) => {
      const items = byDay[key].slice().sort((a, b) => b.ts.localeCompare(a.ts));
      const sum = items.reduce(
        (acc, m) => {
          acc.k += m.celkem.kalorie_kcal || 0;
          acc.b += m.celkem.bilkoviny_g || 0;
          acc.s += m.celkem.sacharidy_g || 0;
          acc.t += m.celkem.tuky_g || 0;
          return acc;
        },
        { k: 0, b: 0, s: 0, t: 0 }
      );

      let goalHtml = "";
      if (goal > 0) {
        const pct = Math.min(100, Math.round((sum.k / goal) * 100));
        const remaining = goal - sum.k;
        const over = remaining < 0;
        const label = over
          ? `překročeno o ${-remaining} kcal`
          : `zbývá ${remaining} kcal`;
        goalHtml = `
          <div class="goalbar">
            <div class="goalbar-track"><div class="goalbar-fill${
              over ? " over" : ""
            }" style="width:${pct}%"></div></div>
            <div class="goalbar-label">${sum.k} / ${goal} kcal · ${label}</div>
          </div>`;
      }

      return `
        <div class="day">
          <div class="day-head"><span>${fmtDay(key)}</span><strong>${sum.k} kcal</strong></div>
          <div class="day-macros">B ${sum.b} g · S ${sum.s} g · T ${sum.t} g · ${items.length}× jídlo</div>
          ${goalHtml}
          ${items.map(mealRowHtml).join("")}
        </div>`;
    })
    .join("");

  diaryBody.querySelectorAll(".del").forEach((btn) =>
    btn.addEventListener("click", () => deleteMeal(btn.dataset.id))
  );
  diaryBody.querySelectorAll(".edit").forEach((btn) =>
    btn.addEventListener("click", () => {
      editingId = btn.dataset.id;
      renderDiary();
    })
  );
  diaryBody.querySelectorAll(".cancel").forEach((btn) =>
    btn.addEventListener("click", () => {
      editingId = null;
      renderDiary();
    })
  );
  diaryBody.querySelectorAll(".save").forEach((btn) =>
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const container = btn.closest(".meal");
      const list = loadMeals();
      const m = list.find((x) => x.id === id);
      if (m && container) {
        container.querySelectorAll(".ef").forEach((inp) => {
          const f = inp.dataset.f;
          if (CELKEM_FIELDS.includes(f)) {
            m.celkem[f] = parseInt(inp.value, 10) || 0;
          } else {
            m[f] = inp.value;
          }
        });
        saveMeals(list);
      }
      editingId = null;
      refreshViews();
    })
  );
}

// === Export ===
function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(value) {
  const s = String(value);
  return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportCsv() {
  const meals = loadMeals()
    .slice()
    .sort((a, b) => a.ts.localeCompare(b.ts));
  if (meals.length === 0) {
    setStatus("Deník je prázdný — není co exportovat.", "error");
    return;
  }
  const head = [
    "datum",
    "cas",
    "nazev",
    "kalorie_kcal",
    "bilkoviny_g",
    "sacharidy_g",
    "tuky_g",
    "poznamka",
  ];
  const rows = meals.map((m) =>
    [
      dayKey(m.ts),
      fmtTime(m.ts),
      m.nazev,
      m.celkem.kalorie_kcal || 0,
      m.celkem.bilkoviny_g || 0,
      m.celkem.sacharidy_g || 0,
      m.celkem.tuky_g || 0,
      m.poznamka || "",
    ]
      .map(csvCell)
      .join(";")
  );
  // BOM (﻿) kvůli diakritice v Excelu; ";" oddělovač pro český Excel
  const csv = "﻿" + [head.join(";"), ...rows].join("\r\n");
  download(
    `kalorie-${dayKey(new Date().toISOString())}.csv`,
    csv,
    "text/csv;charset=utf-8"
  );
}

function exportJson() {
  // miniatury vynecháme, ať je export malý
  const meals = loadMeals().map(({ thumb, ...rest }) => rest);
  if (meals.length === 0) {
    setStatus("Deník je prázdný — není co exportovat.", "error");
    return;
  }
  download(
    `kalorie-${dayKey(new Date().toISOString())}.json`,
    JSON.stringify(meals, null, 2),
    "application/json"
  );
}

exportCsvBtn.addEventListener("click", exportCsv);
exportJsonBtn.addEventListener("click", exportJson);

// === Přehled (týden / měsíc / vlastní rozsah) ===
function rangeForPeriod() {
  const todayKey = dayKey(new Date().toISOString());
  if (currentPeriod === "custom") {
    const f = rangeFrom.value || todayKey;
    const t = rangeTo.value || todayKey;
    return f <= t ? { from: f, to: t } : { from: t, to: f };
  }
  const n = currentPeriod === "30" ? 30 : 7;
  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - (n - 1));
  return { from: dayKey(from.toISOString()), to: todayKey };
}

function fmtDayShort(key) {
  const [, m, d] = key.split("-");
  return `${+d}. ${+m}.`;
}

function eachDay(fromKey, toKey, cb) {
  const d = new Date(fromKey + "T00:00:00");
  const end = new Date(toKey + "T00:00:00");
  let guard = 0;
  while (d <= end && guard < 1000) {
    cb(dayKey(d.toISOString()));
    d.setDate(d.getDate() + 1);
    guard++;
  }
}

function renderOverview() {
  const { from, to } = rangeForPeriod();
  const goal = getGoal();

  const byDay = {};
  loadMeals().forEach((m) => {
    const k = dayKey(m.ts);
    if (k < from || k > to) return;
    const e = (byDay[k] = byDay[k] || { k: 0, b: 0, s: 0, t: 0 });
    e.k += m.celkem.kalorie_kcal || 0;
    e.b += m.celkem.bilkoviny_g || 0;
    e.s += m.celkem.sacharidy_g || 0;
    e.t += m.celkem.tuky_g || 0;
  });

  const keys = Object.keys(byDay);
  const rangeLabel = `${fmtDayShort(from)} – ${fmtDayShort(to)} ${to.split("-")[0]}`;

  if (keys.length === 0) {
    overviewBody.innerHTML = `<div class="ov-range">${rangeLabel}</div><p class="empty">Žádné záznamy v tomto období.</p>`;
    return;
  }

  let totalK = 0,
    totalB = 0,
    totalS = 0,
    totalT = 0,
    inGoal = 0,
    maxK = 0;
  keys.forEach((k) => {
    const e = byDay[k];
    totalK += e.k;
    totalB += e.b;
    totalS += e.s;
    totalT += e.t;
    if (e.k > maxK) maxK = e.k;
    if (goal > 0 && e.k <= goal) inGoal++;
  });
  const nDays = keys.length;
  const avg = Math.round(totalK / nDays);

  let html = `<div class="ov-range">${rangeLabel}</div>`;
  html += `
    <div class="ov-stats">
      <div><span>Ø kcal/den</span><strong>${avg}</strong></div>
      <div><span>Dní se záznamem</span><strong>${nDays}</strong></div>
      <div><span>Celkem</span><strong>${totalK} kcal</strong></div>
      <div><span>Ø makra/den</span><strong>B ${Math.round(
        totalB / nDays
      )} · S ${Math.round(totalS / nDays)} · T ${Math.round(
    totalT / nDays
  )} g</strong></div>
    </div>`;

  if (goal > 0) {
    const pctGoal = Math.round((avg / goal) * 100);
    html += `<div class="ov-goal">V cíli (≤ ${goal} kcal): <strong>${inGoal} z ${nDays} dní</strong> · průměr ${pctGoal} % cíle</div>`;
  }

  const allDays = [];
  eachDay(from, to, (k) => allDays.push(k));
  if (allDays.length <= 92) {
    const scaleMax = Math.max(maxK, goal || 0, 1);
    const showLabels = allDays.length <= 10;
    const bars = allDays
      .map((k) => {
        const v = byDay[k] ? byDay[k].k : 0;
        const h = Math.round((v / scaleMax) * 100);
        const over = goal > 0 && v > goal;
        return `<div class="bar${
          over ? " over" : ""
        }" style="height:${h}%" title="${fmtDayShort(k)}: ${v} kcal"></div>`;
      })
      .join("");
    const goalLine =
      goal > 0
        ? `<div class="chart-goal" style="bottom:${Math.min(
            100,
            (goal / scaleMax) * 100
          )}%"></div>`
        : "";
    html += `<div class="chart">${goalLine}<div class="bars">${bars}</div></div>`;
    if (showLabels) {
      html += `<div class="chart-labels">${allDays
        .map((k) => `<span>${+k.split("-")[2]}.</span>`)
        .join("")}</div>`;
    }
  } else {
    html += `<p class="hint">Graf se nezobrazuje pro rozsah delší než 92 dní.</p>`;
  }

  overviewBody.innerHTML = html;
}

function refreshViews() {
  renderDiary();
  renderOverview();
}

periodTabs.forEach((tab) =>
  tab.addEventListener("click", () => {
    currentPeriod = tab.dataset.period;
    periodTabs.forEach((t) => t.classList.toggle("active", t === tab));
    if (currentPeriod === "custom") {
      customRange.hidden = false;
      if (!rangeFrom.value || !rangeTo.value) {
        const today = new Date();
        const from = new Date(today);
        from.setDate(today.getDate() - 6);
        rangeFrom.value = dayKey(from.toISOString());
        rangeTo.value = dayKey(today.toISOString());
      }
    } else {
      customRange.hidden = true;
    }
    renderOverview();
  })
);

[rangeFrom, rangeTo].forEach((el) =>
  el.addEventListener("change", renderOverview)
);

refreshViews();
