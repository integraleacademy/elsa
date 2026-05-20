const STORAGE_KEY = "elsaLibrary_EMPTY_MANUAL_v1";
let books = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
let statusFilter = "", sortBy = "recent", editIndex = null, tempCover = "";

let scannerStream = null;
let scannerTimer = null;
let scannerActive = false;
let barcodeDetector = null;
let zxingReader = null;

function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(books)); }
function esc(s) { return (s || "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])); }
function stars(n) { return n ? "★".repeat(n) + "☆".repeat(5 - n) : "☆☆☆☆☆"; }
function fakeCover(b) { return `<div class="fake-cover"><div class="fake-author">${esc(b.author || "Auteur")}</div><div class="fake-title">${esc(b.title || "Sans titre")}</div><div class="fake-mark">BIBLIOTHÈQUE D’ELSA</div></div>`; }

function applyTheme() {
  const theme = localStorage.getItem("elsa-theme") || "dark";
  document.body.classList.toggle("light", theme === "light");
  const label = document.getElementById("themeLabel");
  if (label) label.textContent = theme === "light" ? "☀️ Mode clair" : "🌙 Mode sombre";
}
function toggleTheme() { localStorage.setItem("elsa-theme", document.body.classList.contains("light") ? "dark" : "light"); applyTheme(); }

function openModal(i = null) {
  editIndex = i;
  modal.classList.add("on");
  modalTitle.textContent = i === null ? "Ajouter un livre" : "Modifier le livre";
  const b = i === null ? { title: "", author: "", status: "À lire", rating: 0, note: "", cover: "" } : books[i];
  t.value = b.title || "";
  a.value = b.author || "";
  st.value = b.status || "À lire";
  rt.value = b.rating || 0;
  note.value = b.note || "";
  coverUrl.value = (b.cover && b.cover.startsWith("http")) ? b.cover : "";
  tempCover = b.cover || "";
  updatePreview();
  hideScannerPanel();
}

function closeModal() {
  stopScanner();
  modal.classList.remove("on");
  editIndex = null;
  tempCover = "";
}

function updatePreview() { preview.innerHTML = tempCover ? `<img src="${tempCover}">` : "Aperçu de la couverture"; }
function chooseCover() { coverUpload.click(); }

coverUpload.onchange = e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { tempCover = reader.result; coverUrl.value = ""; updatePreview(); };
  reader.readAsDataURL(file);
};

coverUrl.oninput = () => { tempCover = coverUrl.value.trim(); updatePreview(); };

function saveBook() {
  if (!t.value.trim()) { alert("Ajoute au moins le titre 😊"); return; }
  const b = {
    title: t.value.trim(), author: a.value.trim(), status: st.value,
    rating: +rt.value, note: note.value.trim(), cover: tempCover,
    added: editIndex === null ? Date.now() : books[editIndex].added
  };
  if (editIndex === null) books.unshift(b); else books[editIndex] = b;
  save(); render(); closeModal();
}

function deleteBook(i) { if (confirm("Supprimer ce livre ?")) { books.splice(i, 1); save(); render(); } }
function setStatus(s) { statusFilter = s; render(); }
function toggleAuthor() { if (typeof authorPanel !== "undefined") authorPanel.style.display = authorPanel.style.display === "none" ? "block" : "none"; }

function setAuthorSearch(v) {
  authorFilter.value = v || "";
  const a = document.getElementById("authorSearch"), m = document.getElementById("mobileAuthorSearch");
  if (a && a.value !== v) a.value = v;
  if (m && m.value !== v) m.value = v;
  render();
}

function render() {
  const q = search.value.toLowerCase(), au = authorFilter.value.toLowerCase();
  let arr = books.map((b, i) => ({ ...b, _i: i })).filter(b =>
    (!statusFilter || b.status === statusFilter) &&
    (!au || (b.author || "").toLowerCase().includes(au)) &&
    (!q || (b.title + " " + b.author).toLowerCase().includes(q))
  );
  arr.sort((a, b) => sortBy === "title" ? a.title.localeCompare(b.title)
    : sortBy === "author" ? a.author.localeCompare(b.author)
    : sortBy === "rating" ? (b.rating || 0) - (a.rating || 0)
    : (b.added || 0) - (a.added || 0));

  grid.innerHTML = arr.length ? arr.map(b => `
    <article class="book"><div class="cover">${fakeCover(b)}${b.cover ? `<img src="${esc(b.cover)}" onerror="this.remove()">` : ""}</div>
    <div class="info"><div class="title">${esc(b.title)}</div><div class="author">${esc(b.author)}</div><div class="stars">${stars(b.rating)}</div>
    <span class="badge">${esc(b.status)}</span><div class="cardBtns"><button onclick="openModal(${b._i})">Modifier</button><button onclick="deleteBook(${b._i})">Supprimer</button></div></div></article>
  `).join("") : `<div class="empty">Aucun livre pour le moment.<br><br>Clique sur “+ Ajouter” pour commencer ta bibliothèque 📚</div>`;
  update();
}

function update() {
  count.textContent = books.length;
  totalMini.textContent = books.length;
  sTotal.textContent = books.length;
  sRead.textContent = books.filter(b => b.status === "Lu").length;
  sCourse.textContent = books.filter(b => b.status === "En cours").length;
  sWish.textContent = books.filter(b => b.status === "Wishlist").length;
  sAuthors.textContent = new Set(books.map(b => b.author).filter(Boolean)).size;
}

function exportData() {
  const blob = new Blob([JSON.stringify(books, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "ma-bibliotheque-elsa.json";
  a.click();
}

function showScannerStatus(msg) {
  const el = document.getElementById("scannerStatus");
  if (el) el.textContent = msg;
}

function hideScannerPanel() {
  const panel = document.getElementById("scannerPanel");
  if (panel) panel.hidden = true;
}

async function ensureZXingLoaded() {
  if (window.ZXing?.BrowserMultiFormatReader) return true;
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://unpkg.com/@zxing/browser@0.1.5/umd/index.min.js";
    script.onload = resolve;
    script.onerror = () => reject(new Error("Impossible de charger ZXing."));
    document.head.appendChild(script);
  });
  return !!window.ZXing?.BrowserMultiFormatReader;
}

function cleanIsbn(rawCode) {
  const clean = (rawCode || "").replace(/[^0-9Xx]/g, "").toUpperCase();
  if (clean.length === 13 && clean.startsWith("978")) return clean;
  if (clean.length === 13 && clean.startsWith("979")) return clean;
  if (clean.length === 12) return clean; // UPC_A
  if (clean.length === 10) return clean;
  return clean;
}

async function fetchBookByISBN(isbn) {
  showScannerStatus("Recherche du livre…");
  const setCover = (url) => {
    if (!url) return;
    tempCover = url;
    coverUrl.value = url;
    updatePreview();
  };

  try {
    const g = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}`);
    if (g.ok) {
      const gj = await g.json();
      if (gj.items?.length) {
        const info = gj.items[0]?.volumeInfo || {};
        if (info.title) t.value = info.title;
        if (Array.isArray(info.authors)) a.value = info.authors.join(", ");
        const image = info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail;
        if (image) setCover(image.replace("http://", "https://"));
        showScannerStatus("Livre trouvé ✅");
        return true;
      }
    }

    const o = await fetch(`https://openlibrary.org/isbn/${encodeURIComponent(isbn)}.json`);
    if (o.ok) {
      const oj = await o.json();
      if (oj.title) t.value = oj.title;
      if (Array.isArray(oj.authors) && oj.authors.length) {
        const names = await Promise.all(oj.authors.map(async (author) => {
          const ref = author?.key;
          if (!ref) return "";
          try {
            const ra = await fetch(`https://openlibrary.org${ref}.json`);
            if (!ra.ok) return "";
            const aj = await ra.json();
            return aj.name || "";
          } catch {
            return "";
          }
        }));
        a.value = names.filter(Boolean).join(", ");
      }
      setCover(`https://covers.openlibrary.org/b/isbn/${encodeURIComponent(isbn)}-L.jpg`);
      showScannerStatus("Livre trouvé ✅");
      return true;
    }

    showScannerStatus("Aucun livre trouvé pour cet ISBN.");
    alert("Aucun livre trouvé avec cet ISBN. Tu peux compléter les champs manuellement 😊");
    return false;
  } catch (e) {
    console.error(e);
    showScannerStatus("Erreur réseau pendant la recherche.");
    alert("Erreur de recherche du livre. Vérifie ta connexion puis réessaie.");
    return false;
  }
}

async function handleDetectedCode(raw) {
  if (!scannerActive) return;
  const isbn = cleanIsbn(raw);
  if (!isbn) return;
  scannerActive = false;
  showScannerStatus(`Code détecté : ${isbn}`);
  stopScanner();
  await fetchBookByISBN(isbn);
}

async function startScanner() {
  const panel = document.getElementById("scannerPanel");
  const video = document.getElementById("scannerVideo");
  panel.hidden = false;

  if (!(window.isSecureContext || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
    showScannerStatus("Le scan caméra fonctionne uniquement en HTTPS ou localhost.");
    alert("Le scanner ISBN nécessite HTTPS (ou localhost). Sur Render, vérifie l'URL en https://.");
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    showScannerStatus("Caméra non disponible sur cet appareil.");
    alert("Caméra non disponible sur cet appareil / navigateur.");
    return;
  }

  try {
    scannerStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false
    });
    video.srcObject = scannerStream;
    await video.play();
    scannerActive = true;
    showScannerStatus("Recherche du livre…");

    if ("BarcodeDetector" in window) {
      barcodeDetector = new BarcodeDetector({ formats: ["ean_13", "upc_a"] });
      scannerTimer = setInterval(async () => {
        if (!scannerActive) return;
        try {
          const codes = await barcodeDetector.detect(video);
          if (codes?.length) await handleDetectedCode(codes[0].rawValue || "");
        } catch (e) {
          console.warn("BarcodeDetector error", e);
        }
      }, 400);
      return;
    }

    const ok = await ensureZXingLoaded();
    if (!ok) throw new Error("ZXing indisponible.");

    zxingReader = new window.ZXing.BrowserMultiFormatReader();
    zxingReader.decodeFromVideoElement(video, (result) => {
      if (result?.text) handleDetectedCode(result.text);
    });
  } catch (e) {
    console.error(e);
    stopScanner();
    const denied = e?.name === "NotAllowedError" || e?.name === "PermissionDeniedError";
    if (denied) {
      showScannerStatus("Accès caméra refusé.");
      alert("Accès caméra refusé. Autorise la caméra pour scanner un ISBN.");
    } else {
      showScannerStatus("Impossible de démarrer la caméra.");
      alert("Impossible de démarrer la caméra sur ce téléphone.");
    }
  }
}

function stopScanner() {
  scannerActive = false;
  if (scannerTimer) {
    clearInterval(scannerTimer);
    scannerTimer = null;
  }
  if (zxingReader?.reset) zxingReader.reset();
  if (scannerStream) {
    scannerStream.getTracks().forEach(track => track.stop());
    scannerStream = null;
  }
  const video = document.getElementById("scannerVideo");
  if (video) video.srcObject = null;
}

document.getElementById("scanIsbnBtn")?.addEventListener("click", startScanner);
document.getElementById("stopScanBtn")?.addEventListener("click", () => {
  stopScanner();
  showScannerStatus("Scan arrêté.");
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
applyTheme();
render();
