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

const JISTOTA_CLASS = { vysoká: "high", střední: "mid", nízká: "low" };

let selectedFile = null;

// Tlačítka jen otevřou příslušný skrytý <input type=file>.
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

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedFile) return;

  setStatus("Analyzuji fotografii… (může to chvíli trvat)", "loading");
  resultsEl.hidden = true;
  submitBtn.disabled = true;

  const data = new FormData();
  data.append("photo", selectedFile);
  data.append("upresneni", upresneniEl.value);

  try {
    const resp = await fetch("/analyze", { method: "POST", body: data });
    const json = await resp.json();
    if (!resp.ok) throw new Error(json.error || "Neznámá chyba.");
    renderResults(json);
    clearStatus();
  } catch (err) {
    setStatus("Chyba: " + err.message, "error");
  } finally {
    submitBtn.disabled = false;
  }
});

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
      <div>
        <dt>Použité upřesnění</dt>
        <dd>${data.pouzite_upresneni ? "ano" : "ne"}</dd>
      </div>
      <div>
        <dt>Celková jistota</dt>
        <dd>${badge(data.celkova_jistota)}</dd>
      </div>
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
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
