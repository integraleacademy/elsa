const STORAGE_KEY = "elsaLibrary_EMPTY_MANUAL_v1";
const ISBN_CACHE_KEY = "elsaIsbnCache_v1";
const BOOKS_API_URL = "/api/books";

function hasMissingMetadata(book) {
  if (!book || !book.title) return false;
  const checks = ["cover", "publisher", "publishedDate", "pageCount", "language", "categories", "description"];
  return checks.some(k => !book[k]);
}
let books = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
let isbnCache = JSON.parse(localStorage.getItem(ISBN_CACHE_KEY) || "{}");
let statusFilter = "", sortBy = "recent", editIndex = null, tempCover = "";
let thrillerNews = [];

let scannerStream = null;
let scannerTimer = null;
let scannerActive = false;
let barcodeDetector = null;
let zxingReader = null;
let zxingControls = null;

async function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(books));
  try {
    const res = await fetch(BOOKS_API_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(books)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.warn("Impossible de synchroniser la bibliothèque sur le serveur.", err);
  }
}
function saveIsbnCache() { localStorage.setItem(ISBN_CACHE_KEY, JSON.stringify(isbnCache)); }
function esc(s) { return (s || "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])); }
function stars(n) { return n ? "★".repeat(n) + "☆".repeat(5 - n) : "☆☆☆☆☆"; }
function ratingButtons(rating, index) {
  return `<div class="stars" role="group" aria-label="Noter le livre">${[1, 2, 3, 4, 5].map(n =>
    `<button type="button" class="star-btn${n <= (rating || 0) ? " on" : ""}" data-rate-index="${index}" data-rate-value="${n}" aria-label="Donner ${n} étoile${n > 1 ? "s" : ""}">★</button>`
  ).join("")}</div>`;
}
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
  publisher.value = b.publisher || "";
  publishedDate.value = b.publishedDate || "";
  pages.value = b.pages || "";
  language.value = b.language || "";
  categories.value = b.categories || "";
  description.value = b.description || "";
  images.value = Array.isArray(b.images) ? b.images.join(", ") : (b.images || "");
  st.value = b.status || "À lire";
  rt.value = b.rating || 0;
  note.value = b.note || "";
  coverUrl.value = (b.cover && b.cover.startsWith("http")) ? b.cover : "";
  tempCover = b.cover || "";
  if (typeof isbn !== "undefined") isbn.value = b.isbn || "";
  updatePreview();
  hideScannerPanel();
}

function openScannerModal() {
  openModal();
  setTimeout(() => { startScanner(); }, 60);
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
    isbn: (typeof isbn !== "undefined" ? isbn.value.trim() : ""),
    publisher: publisher.value.trim(),
    publishedDate: publishedDate.value.trim(),
    pages: pages.value ? +pages.value : 0,
    language: language.value.trim(),
    categories: categories.value.trim(),
    description: description.value.trim(),
    images: images.value.split(",").map(v => v.trim()).filter(Boolean),
    added: editIndex === null ? Date.now() : books[editIndex].added
  };
  if (editIndex === null) books.unshift(b); else books[editIndex] = b;
  save();
  render();
  closeModal();
}

function deleteBook(i) { if (confirm("Supprimer ce livre ?")) { books.splice(i, 1); save(); render(); } }

function rateBook(index, rating) {
  if (typeof books[index] === "undefined") return;
  books[index].rating = rating;
  save();
  render();
}
function syncActiveFilters() {
  document.querySelectorAll(".tabs button[data-status]").forEach(btn => {
    const isActive = (btn.dataset.status || "") === statusFilter;
    btn.classList.toggle("active", isActive);
  });
  document.querySelectorAll(".mobile-nav button[data-status]").forEach(btn => {
    const isActive = (btn.dataset.status || "") === statusFilter;
    btn.classList.toggle("active", isActive);
  });
}

function setStatus(s) { statusFilter = s; render(); }

function updateBookStatus(index, status) {
  if (typeof books[index] === "undefined") return;
  books[index].status = status;
  save();
  render();
}

function cycleBookStatus(index) {
  if (typeof books[index] === "undefined") return;
  const statuses = ["À lire", "En cours", "Lu", "Wishlist"];
  const currentIndex = statuses.indexOf(books[index].status);
  const nextStatus = statuses[(currentIndex + 1) % statuses.length];
  updateBookStatus(index, nextStatus);
}
function toggleAuthor() { if (typeof authorPanel !== "undefined") authorPanel.style.display = authorPanel.style.display === "none" ? "block" : "none"; }

function setAuthorSearch(v) {
  authorFilter.value = v || "";
  const a = document.getElementById("authorSearch"), m = document.getElementById("mobileAuthorSearch");
  if (a && a.value !== v) a.value = v;
  if (m && m.value !== v) m.value = v;
  render();
}

function addNewsToWishlist(title, author, cover) {
  if (!title) return;
  const existing = books.find(b => (b.title || "").toLowerCase() === title.toLowerCase() && (b.author || "").toLowerCase() === (author || "").toLowerCase());
  if (existing) {
    existing.status = "Wishlist";
  } else {
    books.unshift({
      title: title.trim(),
      author: (author || "Auteur inconnu").trim(),
      status: "Wishlist",
      rating: 0,
      note: "",
      cover: cover || "",
      pages: 0,
      added: Date.now()
    });
  }
  save();
  render();
}

async function loadThrillerNews() {
  const list = document.getElementById("thrillerNews");
  if (!list) return;
  list.innerHTML = "Chargement des nouveautés...";

  try {
    const res = await fetch("https://openlibrary.org/subjects/thriller.json?limit=8");
    const data = await res.json();
    const works = Array.isArray(data.works) ? data.works : [];

    thrillerNews = works.map(w => ({
      title: w.title || "Sans titre",
      author: (w.authors && w.authors[0] && w.authors[0].name) ? w.authors[0].name : "Auteur inconnu",
      cover: w.cover_id ? `https://covers.openlibrary.org/b/id/${w.cover_id}-L.jpg` : ""
    }));

    list.innerHTML = thrillerNews.length
      ? thrillerNews.map((w, i) => `<div class="news-item"><div class="news-meta"><b>${esc(w.title)}</b><span>${esc(w.author)}</span></div><button type="button" class="soft" onclick='addNewsToWishlist(${JSON.stringify(w.title)}, ${JSON.stringify(w.author)}, ${JSON.stringify(w.cover)})'>💖 Wishlist</button></div>`).join("")
      : "Aucune nouveauté trouvée pour le moment.";
  } catch (e) {
    thrillerNews = [];
    list.innerHTML = "Impossible de charger les nouveautés pour l'instant.";
  }
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

  if (statusFilter === "Nouveautés") {
    grid.innerHTML = thrillerNews.length ? thrillerNews.map((n, i) => `
      <article class="book"><div class="cover">${n.cover ? `<img src="${esc(n.cover)}" onerror="this.remove()">` : fakeCover(n)}</div>
      <div class="info"><div class="title">${esc(n.title)}</div><div class="author">${esc(n.author)}</div><span class="badge">Nouveauté</span><div class="cardBtns"><button data-news-index="${i}" class="add-news-btn">💖 Wishlist</button></div></div></article>
    `).join("") : `<div class="empty">Aucune nouveauté pour le moment.</div>`;
    update();
    syncActiveFilters();
    return;
  }

  grid.innerHTML = arr.length ? arr.map(b => `
    <article class="book"><div class="cover">${fakeCover(b)}${b.cover ? `<img src="${esc(b.cover)}" onerror="this.remove()">` : ""}</div>
    <div class="info"><div class="title">${esc(b.title)}</div><div class="author">${esc(b.author)}</div>${b.isbn ? `<div class="isbn">ISBN : ${esc(b.isbn)}</div>` : ""}${b.publisher ? `<div class="isbn">Éditeur : ${esc(b.publisher)}</div>` : ""}${b.publishedDate ? `<div class="isbn">Date : ${esc(b.publishedDate)}</div>` : ""}${b.pages ? `<div class="isbn">Pages : ${esc(String(b.pages))}</div>` : ""}${ratingButtons(b.rating, b._i)}
    <button type="button" class="badge" onclick="cycleBookStatus(${b._i})" title="Cliquer pour changer le statut">${esc(b.status)}</button><div class="cardBtns"><button onclick="openModal(${b._i})">Modifier</button><button onclick="deleteBook(${b._i})">Supprimer</button></div></div></article>
  `).join("") : `<div class="empty">Aucun livre pour le moment.<br><br>Clique sur “+ Ajouter” pour commencer ta bibliothèque 📚</div>`;
  update();
  syncActiveFilters();
}

function update() {
  count.textContent = books.length;
  totalMini.textContent = books.length;
  const readPages = books.filter(b => b.status === "Lu").reduce((sum, b) => sum + (Number(b.pages) || 0), 0);
  const readPagesEl = document.getElementById("totalReadPages");
  if (readPagesEl) readPagesEl.textContent = String(readPages);
}

async function loadBooks() {
  try {
    const res = await fetch(BOOKS_API_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const serverBooks = await res.json();
    if (Array.isArray(serverBooks)) {
      books = serverBooks;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(books));
    }
  } catch (err) {
    console.warn("Impossible de charger la bibliothèque depuis le serveur, utilisation des données locales.", err);
  } finally {
    render();
  }
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
  const compact = (rawCode || "").replace(/\s+/g, "").replace(/-/g, "");
  const clean = compact.replace(/[^0-9Xx]/g, "").toUpperCase();
  if (clean.length === 13 && (clean.startsWith("978") || clean.startsWith("979"))) return clean;
  return clean;
}

async function fetchBookByISBN(isbn) {
  showScannerStatus("Recherche du livre…");
  console.log("Recherche ISBN backend :", isbn);
  if (typeof window.isbn !== "undefined") window.isbn.value = isbn;
  showScannerStatus(`ISBN détecté : ${isbn}`);

  const cached = isbnCache[isbn];
  if (cached?.title && !hasMissingMetadata(cached)) {
    t.value = cached.title || "";
    a.value = cached.authors || "";
    publisher.value = cached.publisher || "";
    publishedDate.value = cached.publishedDate || "";
    pages.value = cached.pageCount || "";
    language.value = cached.language || "";
    categories.value = cached.categories || "";
    description.value = cached.description || "";
    images.value = Array.isArray(cached.images) ? cached.images.join(", ") : "";
    const cachedCover = cached.cover || (Array.isArray(cached.images) ? (cached.images[0] || "") : "");
    coverUrl.value = cachedCover;
    tempCover = cachedCover;
    updatePreview();
    console.log("Source utilisée :", "cache local");
    showScannerStatus(`ISBN détecté : ${isbn} — Livre trouvé automatiquement`);
    return true;
  }

  try {
    const r = await fetch(`/api/isbn/${encodeURIComponent(isbn)}`);
    const data = await r.json();
    console.log("Réponse backend ISBN :", data);

    if (r.ok && data?.found) {
      t.value = data.title || "";
      a.value = data.authors || "";
      publisher.value = data.publisher || "";
      publishedDate.value = data.publishedDate || data.date || "";
      pages.value = data.pageCount || "";
      language.value = data.language || "";
      categories.value = data.categories || "";
      description.value = data.description || "";
      images.value = Array.isArray(data.images) ? data.images.join(", ") : "";
      const foundCover = data.cover || (Array.isArray(data.images) ? (data.images[0] || "") : "");
      coverUrl.value = foundCover;
      tempCover = foundCover;
      updatePreview();
      isbnCache[isbn] = {
        isbn,
        title: data.title || "",
        authors: data.authors || "",
        cover: data.cover || "",
        publisher: data.publisher || "",
        publishedDate: data.publishedDate || data.date || "",
        pageCount: data.pageCount || 0,
        language: data.language || "",
        categories: data.categories || "",
        description: data.description || ""
        ,
        images: Array.isArray(data.images) ? data.images : []
      };
      saveIsbnCache();
      console.log("Source utilisée :", "backend api");
      if (data.isbn && typeof window.isbn !== "undefined") window.isbn.value = data.isbn;
      showScannerStatus("Livre trouvé automatiquement");
      return true;
    }

    console.log("Source utilisée :", "aucune");
    if (typeof window.isbn !== "undefined") window.isbn.value = data?.isbn || isbn;
    if (data?.rateLimited) {
      showScannerStatus("Recherche automatique temporairement limitée. Vous pouvez compléter le titre et l’auteur manuellement.");
      return false;
    }
    showScannerStatus((data && data.message) || `ISBN détecté : ${isbn} — Livre non trouvé automatiquement. Vous pouvez compléter les informations manuellement.`);
    return false;
  } catch (e) {
    console.error(e);
    showScannerStatus(`ISBN détecté : ${isbn} — Recherche indisponible. Vous pouvez compléter les informations manuellement.`);
    return false;
  }
}


async function handleDetectedCode(raw) {
  if (!scannerActive) return;
  console.log("ISBN scanné brut :", raw);
  const isbn = cleanIsbn(raw);
  console.log("ISBN normalisé :", isbn);
  if (!isbn) return;
  scannerActive = false;
  showScannerStatus(`Code détecté : ${isbn}`);
  stopScanner();
  await fetchBookByISBN(isbn);
}

async function handleManualIsbnSearch() {
  const rawCode = document.getElementById("manualIsbnInput")?.value || "";
  console.log("ISBN scanné brut :", rawCode);
  const isbn = cleanIsbn(rawCode);
  console.log("ISBN normalisé :", isbn);
  if (!isbn) {
    showScannerStatus("Veuillez saisir un ISBN valide.");
    return;
  }
  showScannerStatus(`Code détecté : ${isbn}`);
  await fetchBookByISBN(isbn);
}


function cameraTroubleshootingMessage(err) {
  const name = err?.name || "";
  const iosHint = (/iPhone|iPad|iPod/i.test(navigator.userAgent))
    ? "Sur iPhone/iPad, ouvrez le site directement dans Safari (pas dans un navigateur intégré) puis autorisez Caméra dans aA > Réglages du site web > Caméra."
    : "";

  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Accès caméra refusé. Autorise la caméra pour ce site puis relance le scan.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "Caméra occupée par une autre app. Ferme les autres apps utilisant la caméra puis réessaie.";
  }
  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
    return "Caméra arrière indisponible. Réessaie après rotation du téléphone ou redémarrage du navigateur.";
  }
  if (name === "AbortError") {
    return "Démarrage caméra interrompu. Réessaie dans quelques secondes.";
  }
  return (`Impossible de démarrer la caméra sur ce téléphone. ${iosHint}`).trim();
}

async function startScanner() {
  stopScanner();
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
    const attempts = [
      { video: { facingMode: { exact: "environment" } }, audio: false },
      { video: { facingMode: "environment" }, audio: false },
      { video: true, audio: false }
    ];
    let lastErr = null;
    for (const c of attempts) {
      try {
        scannerStream = await navigator.mediaDevices.getUserMedia(c);
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!scannerStream) throw lastErr || new Error("Camera stream unavailable");

    video.setAttribute("playsinline", "true");
    video.muted = true;
    video.srcObject = scannerStream;
    await video.play();
    scannerActive = true;
    showScannerStatus("Recherche du livre…");

    if ("BarcodeDetector" in window) {
      try {
        barcodeDetector = new BarcodeDetector({ formats: ["ean_13", "upc_a"] });
      } catch (err) {
        console.warn("BarcodeDetector unsupported formats, fallback ZXing", err);
        barcodeDetector = null;
      }
      if (barcodeDetector) {
        scannerTimer = setInterval(async () => {
          if (!scannerActive) return;
          try {
            const codes = await barcodeDetector.detect(video);
            if (codes?.length) await handleDetectedCode(codes[0].rawValue || "");
          } catch (e) {
            console.warn("BarcodeDetector error", e);
          }
        }, 450);
        return;
      }
    }

    const ok = await ensureZXingLoaded();
    if (!ok) throw new Error("ZXing indisponible.");

    zxingReader = new window.ZXing.BrowserMultiFormatReader();
    zxingControls = await zxingReader.decodeFromVideoDevice(undefined, video, (result) => {
      if (result?.text) handleDetectedCode(result.text);
    });
  } catch (e) {
    console.error(e);
    stopScanner();
    const msg = cameraTroubleshootingMessage(e);
    showScannerStatus(msg);
    alert(msg);
  }
}

function stopScanner() {
  scannerActive = false;
  if (scannerTimer) {
    clearInterval(scannerTimer);
    scannerTimer = null;
  }
  if (zxingControls?.stop) zxingControls.stop();
  zxingControls = null;
  if (zxingReader?.reset) zxingReader.reset();
  if (scannerStream) {
    scannerStream.getTracks().forEach(track => track.stop());
    scannerStream = null;
  }
  const video = document.getElementById("scannerVideo");
  if (video) video.srcObject = null;
}

document.getElementById("scanIsbnBtn")?.addEventListener("click", startScanner);
document.getElementById("manualIsbnSearchBtn")?.addEventListener("click", handleManualIsbnSearch);
document.getElementById("manualIsbnInput")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    handleManualIsbnSearch();
  }
});
document.getElementById("stopScanBtn")?.addEventListener("click", () => {
  stopScanner();
  showScannerStatus("Scan arrêté.");
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
applyTheme();
loadBooks();
loadThrillerNews();


grid.addEventListener("click", (event) => {
  const btn = event.target.closest(".star-btn");
  if (!btn) return;
  const index = Number(btn.dataset.rateIndex);
  const rating = Number(btn.dataset.rateValue);
  if (!Number.isInteger(index) || !Number.isInteger(rating)) return;
  rateBook(index, rating);
});



grid.addEventListener("click", (event) => {
  const newsBtn = event.target.closest(".add-news-btn");
  if (!newsBtn) return;
  const i = Number(newsBtn.dataset.newsIndex);
  const n = thrillerNews[i];
  if (!n) return;
  addNewsToWishlist(n.title, n.author, n.cover);
});
