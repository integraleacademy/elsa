from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory


app = Flask(__name__, static_folder=".", static_url_path="")


DATA_DIR = Path(os.environ.get("ELSA_DATA_DIR", "/data"))
if not DATA_DIR.exists() or not os.access(DATA_DIR, os.W_OK):
    DATA_DIR = Path("./data")
DATA_DIR.mkdir(parents=True, exist_ok=True)
BOOKS_FILE = DATA_DIR / "books.json"


def _read_books() -> list[dict]:
    if not BOOKS_FILE.exists():
        return []
    try:
        with BOOKS_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def _write_books(books: list[dict]) -> None:
    tmp_file = BOOKS_FILE.with_suffix(".tmp")
    with tmp_file.open("w", encoding="utf-8") as f:
        json.dump(books, f, ensure_ascii=False)
    tmp_file.replace(BOOKS_FILE)


@app.get("/")
def index():
    return send_from_directory(".", "index.html")


@app.get("/api/books")
def get_books():
    return jsonify(_read_books())


@app.put("/api/books")
def put_books():
    payload = request.get_json(silent=True)
    if not isinstance(payload, list):
        return jsonify({"error": "Payload must be a JSON array."}), 400
    _write_books(payload)
    return jsonify({"ok": True, "count": len(payload)})




def _normalize_isbn(raw: str) -> str:
    compact = (raw or "").strip().replace(" ", "").replace("-", "")
    clean = "".join(ch for ch in compact if ch.isdigit() or ch in "Xx").upper()
    if len(clean) == 13 and (clean.startswith("978") or clean.startswith("979")):
        return clean
    if len(clean) == 10:
        return clean
    return ""


def _safe_get_json(url: str) -> dict | list | None:
    try:
        with urllib.request.urlopen(url, timeout=8) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as err:
        print("Erreur API:", url, err)
        return None


def _safe_get_text(url: str) -> str | None:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; ElsaLibraryBot/1.0; +https://example.local)"
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            return response.read().decode(charset, errors="replace")
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as err:
        print("Erreur page web:", url, err)
        return None


def _extract_title_from_html(html: str) -> str:
    patterns = [
        r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']',
        r'<meta[^>]+name=["\']twitter:title["\'][^>]+content=["\']([^"\']+)["\']',
        r"<title>(.*?)</title>",
    ]
    for pattern in patterns:
        match = re.search(pattern, html, flags=re.IGNORECASE | re.DOTALL)
        if match:
            title = re.sub(r"\s+", " ", match.group(1)).strip()
            if title:
                return title
    return ""


def _search_book_web_fallback(isbn: str) -> dict | None:
    sources = [
        ("Decitre", f"https://www.decitre.fr/rechercher/result?q={urllib.parse.quote(isbn)}"),
        ("Babelio", f"https://www.babelio.com/recherche.php?q={urllib.parse.quote(isbn)}"),
        ("LesLibraires", f"https://www.leslibraires.fr/listeliv.php?base=paper&form_recherche_avancee=ok&isbn={urllib.parse.quote(isbn)}"),
    ]
    for source_name, url in sources:
        print("Fallback web:", source_name, url)
        html = _safe_get_text(url)
        if not html:
            continue
        if isbn not in html.replace("-", "").replace(" ", ""):
            continue
        title = _extract_title_from_html(html)
        if title:
            return {
                "found": True,
                "isbn": isbn,
                "title": title,
                "authors": "",
                "cover": "",
                "source": source_name,
            }
    return None


@app.get("/api/isbn/<isbn>")
def lookup_isbn(isbn):
    normalized_isbn = _normalize_isbn(isbn)
    print("Recherche ISBN:", normalized_isbn or isbn)

    if not normalized_isbn:
        return jsonify({"found": False, "isbn": isbn, "error": "Livre non trouvé"})

    google_url = f"https://www.googleapis.com/books/v1/volumes?q=isbn:{urllib.parse.quote(normalized_isbn)}"
    print("Google Books:", google_url)
    google_data = _safe_get_json(google_url)
    if isinstance(google_data, dict) and google_data.get("totalItems", 0) > 0 and google_data.get("items"):
        info = google_data["items"][0].get("volumeInfo", {})
        title = info.get("title")
        if title:
            authors = ", ".join(info.get("authors", []))
            cover = info.get("imageLinks", {}).get("thumbnail") or info.get("imageLinks", {}).get("smallThumbnail") or ""
            if cover.startswith("http://"):
                cover = "https://" + cover[len("http://"):]
            print("Livre trouvé:", title)
            return jsonify({"found": True, "isbn": normalized_isbn, "title": title, "authors": authors, "cover": cover})

    google_fallback_url = f"https://www.googleapis.com/books/v1/volumes?q={urllib.parse.quote(normalized_isbn)}"
    print("Google Books:", google_fallback_url)
    google_fallback_data = _safe_get_json(google_fallback_url)
    if isinstance(google_fallback_data, dict) and google_fallback_data.get("totalItems", 0) > 0 and google_fallback_data.get("items"):
        info = google_fallback_data["items"][0].get("volumeInfo", {})
        title = info.get("title")
        if title:
            authors = ", ".join(info.get("authors", []))
            cover = info.get("imageLinks", {}).get("thumbnail") or info.get("imageLinks", {}).get("smallThumbnail") or ""
            if cover.startswith("http://"):
                cover = "https://" + cover[len("http://"):]
            print("Livre trouvé:", title)
            return jsonify({"found": True, "isbn": normalized_isbn, "title": title, "authors": authors, "cover": cover})

    open_books_url = (
        "https://openlibrary.org/api/books"
        f"?bibkeys=ISBN:{urllib.parse.quote(normalized_isbn)}&format=json&jscmd=data"
    )
    print("Open Library:", open_books_url)
    open_books_data = _safe_get_json(open_books_url)
    if isinstance(open_books_data, dict):
        entry = open_books_data.get(f"ISBN:{normalized_isbn}")
        if isinstance(entry, dict) and entry.get("title"):
            title = entry.get("title", "")
            authors = ", ".join(
                author.get("name", "")
                for author in entry.get("authors", [])
                if isinstance(author, dict) and author.get("name")
            )
            cover = ""
            if isinstance(entry.get("cover"), dict):
                cover = entry["cover"].get("large") or entry["cover"].get("medium") or entry["cover"].get("small") or ""
            if not cover:
                cover = f"https://covers.openlibrary.org/b/isbn/{urllib.parse.quote(normalized_isbn)}-L.jpg"
            print("Livre trouvé:", title)
            return jsonify({"found": True, "isbn": normalized_isbn, "title": title, "authors": authors, "cover": cover})

    open_isbn_url = f"https://openlibrary.org/isbn/{urllib.parse.quote(normalized_isbn)}.json"
    print("Open Library:", open_isbn_url)
    open_isbn_data = _safe_get_json(open_isbn_url)
    if isinstance(open_isbn_data, dict) and open_isbn_data.get("title"):
        title = open_isbn_data.get("title", "")
        authors = ""
        author_names: list[str] = []
        for author in open_isbn_data.get("authors", []):
            if not isinstance(author, dict):
                continue
            key = author.get("key")
            if not key:
                continue
            author_url = f"https://openlibrary.org{key}.json"
            author_data = _safe_get_json(author_url)
            if isinstance(author_data, dict) and author_data.get("name"):
                author_names.append(author_data["name"])
        if author_names:
            authors = ", ".join(author_names)
        cover = f"https://covers.openlibrary.org/b/isbn/{urllib.parse.quote(normalized_isbn)}-L.jpg"
        print("Livre trouvé:", title)
        return jsonify({"found": True, "isbn": normalized_isbn, "title": title, "authors": authors, "cover": cover})

    scraped = _search_book_web_fallback(normalized_isbn)
    if scraped:
        return jsonify(scraped)

    return jsonify(
        {
            "found": False,
            "isbn": normalized_isbn,
            "message": "Livre non trouvé automatiquement. Complète le titre et l’auteur manuellement.",
        }
    )

@app.get("/<path:path>")
def static_files(path):
    return send_from_directory(".", path)
