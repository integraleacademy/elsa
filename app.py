from __future__ import annotations

import json
import os
import re
import unicodedata
from datetime import datetime, timezone
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory


app = Flask(__name__, static_folder=".", static_url_path="")


DATA_DIR = Path(os.environ.get("ELSA_DATA_DIR", "/data"))
if not DATA_DIR.exists() or not os.access(DATA_DIR, os.W_OK):
    DATA_DIR = Path("./data")
DATA_DIR.mkdir(parents=True, exist_ok=True)
BOOKS_FILE = DATA_DIR / "books.json"
ISBN_CACHE_FILE = DATA_DIR / "isbn_cache.json"

KNOWN_ISBN = {
    "9782749956664": {
        "found": True,
        "isbn": "9782749956664",
        "title": "D’entre les morts",
        "authors": "Alexis Laipsker",
        "publisher": "Michel Lafon",
        "cover": "",
    },
    "9782265159075": {
        "found": True,
        "isbn": "9782265159075",
        "title": "L’Autre moi",
        "authors": "Franck Thilliez",
        "publisher": "Fleuve Éditions",
        "cover": "",
    },
}


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
    except urllib.error.HTTPError as err:
        if err.code == 429:
            raise
        print("Erreur API:", url, err)
        return None
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as err:
        print("Erreur API:", url, err)
        return None


def _normalize_text_key(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value or "")
    without_accents = "".join(ch for ch in normalized if not unicodedata.combining(ch))
    lowered = without_accents.lower()
    return re.sub(r"[^a-z0-9]+", " ", lowered).strip()


def _join_unique(values: list[str]) -> str:
    seen: set[str] = set()
    result: list[str] = []
    for raw in values:
        cleaned = (raw or "").strip()
        if not cleaned:
            continue
        key = _normalize_text_key(cleaned)
        if key in seen:
            continue
        seen.add(key)
        result.append(cleaned)
    return ", ".join(result)


def _build_payload(
    isbn: str,
    *,
    title: str = "",
    authors: str = "",
    publisher: str = "",
    published_date: str = "",
    page_count: int = 0,
    language: str = "",
    categories: str = "",
    description: str = "",
    cover: str = "",
    images: list[str] | None = None,
    source: str = "",
) -> dict:
    image_list = [img for img in (images or []) if isinstance(img, str) and img.strip()]
    return {
        "found": bool(title),
        "source": source,
        "isbn": isbn,
        "title": title,
        "authors": authors,
        "publisher": publisher,
        "publishedDate": published_date,
        "pageCount": page_count or 0,
        "language": language,
        "categories": categories,
        "description": description,
        "cover": cover,
        "images": image_list,
    }


def _extract_google_images(image_links: dict) -> list[str]:
    if not isinstance(image_links, dict):
        return []
    urls: list[str] = []
    for key in ("extraLarge", "large", "medium", "small", "thumbnail", "smallThumbnail"):
        value = image_links.get(key)
        if isinstance(value, str) and value.strip():
            if value.startswith("http://"):
                value = "https://" + value[len("http://"):]
            urls.append(value)
    return list(dict.fromkeys(urls))


def _read_isbn_cache() -> dict[str, dict]:
    if not ISBN_CACHE_FILE.exists():
        return {}
    try:
        with ISBN_CACHE_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def _write_isbn_cache(cache: dict[str, dict]) -> None:
    tmp_file = ISBN_CACHE_FILE.with_suffix(".tmp")
    with tmp_file.open("w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)
    tmp_file.replace(ISBN_CACHE_FILE)


def _cache_isbn_result(isbn: str, payload: dict) -> None:
    cache = _read_isbn_cache()
    row = dict(payload)
    row["cachedAt"] = datetime.now(timezone.utc).isoformat()
    cache[isbn] = row
    _write_isbn_cache(cache)




def _has_missing_enrichment_fields(payload: dict) -> bool:
    if not isinstance(payload, dict) or not payload.get("found"):
        return False
    return any(
        not payload.get(field)
        for field in ("cover", "publisher", "publishedDate", "pageCount", "language", "categories", "description")
    )
def _extract_google_volume_info(data: dict | None) -> dict:
    if not isinstance(data, dict) or data.get("totalItems", 0) <= 0 or not data.get("items"):
        return {}

    def score(info: dict) -> int:
        pts = 0
        if not isinstance(info, dict):
            return -1
        if info.get("description"):
            pts += 3
        if isinstance(info.get("pageCount"), int) and info.get("pageCount", 0) > 0:
            pts += 3
        if info.get("publisher"):
            pts += 1
        if info.get("categories"):
            pts += 1
        if info.get("imageLinks"):
            pts += 1
        return pts

    best: dict = {}
    best_score = -1
    for item in data.get("items", []):
        info = item.get("volumeInfo", {}) if isinstance(item, dict) else {}
        s = score(info)
        if s > best_score:
            best = info if isinstance(info, dict) else {}
            best_score = s
    return best if isinstance(best, dict) else {}


def _enrich_with_google(isbn: str, payload: dict) -> dict:
    url = f"https://www.googleapis.com/books/v1/volumes?q=isbn:{urllib.parse.quote(isbn)}"
    try:
        info = _extract_google_volume_info(_safe_get_json(url))
    except urllib.error.HTTPError:
        return payload
    if not info:
        return payload
    image_list = _extract_google_images(info.get("imageLinks", {}))
    return {
        **payload,
        "publisher": payload.get("publisher") or info.get("publisher", ""),
        "publishedDate": payload.get("publishedDate") or info.get("publishedDate", ""),
        "pageCount": payload.get("pageCount") or (info.get("pageCount", 0) if isinstance(info.get("pageCount"), int) else 0),
        "language": payload.get("language") or info.get("language", ""),
        "categories": payload.get("categories") or _join_unique(info.get("categories", []) if isinstance(info.get("categories"), list) else []),
        "description": payload.get("description") or info.get("description", ""),
        "cover": payload.get("cover") or (image_list[0] if image_list else ""),
        "images": payload.get("images") or image_list,
        "source": payload.get("source", "") + "+google_enrich",
    }




def _enrich_with_openlibrary(isbn: str, payload: dict) -> dict:
    url = (
        "https://openlibrary.org/api/books"
        f"?bibkeys=ISBN:{urllib.parse.quote(isbn)}&format=json&jscmd=data"
    )
    data = _safe_get_json(url)
    if not isinstance(data, dict):
        return payload

    entry = data.get(f"ISBN:{isbn}")
    if not isinstance(entry, dict):
        return payload

    cover = ""
    images: list[str] = []
    if isinstance(entry.get("cover"), dict):
        cover = entry["cover"].get("large") or entry["cover"].get("medium") or entry["cover"].get("small") or ""
        images = [u for u in [entry["cover"].get("large", ""), entry["cover"].get("medium", ""), entry["cover"].get("small", "")] if u]

    publishers = _join_unique([p.get("name", "") for p in entry.get("publishers", []) if isinstance(p, dict)])
    categories = _join_unique([s.get("name", "") for s in entry.get("subjects", []) if isinstance(s, dict)])

    return {
        **payload,
        "publisher": payload.get("publisher") or publishers,
        "publishedDate": payload.get("publishedDate") or entry.get("publish_date", ""),
        "pageCount": payload.get("pageCount") or (entry.get("number_of_pages", 0) if isinstance(entry.get("number_of_pages"), int) else 0),
        "categories": payload.get("categories") or categories,
        "cover": payload.get("cover") or cover,
        "images": payload.get("images") or images,
        "source": payload.get("source", "") + "+openlibrary_enrich",
    }




def _enrich_openlibrary_details(isbn: str, payload: dict) -> dict:
    url = f"https://openlibrary.org/isbn/{urllib.parse.quote(isbn)}.json"
    data = _safe_get_json(url)
    if not isinstance(data, dict):
        return payload

    page_count = data.get("number_of_pages", 0) if isinstance(data.get("number_of_pages"), int) else 0
    description = ""

    work_key = ""
    works = data.get("works", [])
    if isinstance(works, list):
        for work in works:
            if isinstance(work, dict) and isinstance(work.get("key"), str):
                work_key = work["key"]
                break

    if work_key:
        work_data = _safe_get_json(f"https://openlibrary.org{work_key}.json")
        if isinstance(work_data, dict):
            raw_desc = work_data.get("description", "")
            if isinstance(raw_desc, str):
                description = raw_desc
            elif isinstance(raw_desc, dict):
                description = raw_desc.get("value", "") if isinstance(raw_desc.get("value"), str) else ""

    return {
        **payload,
        "pageCount": payload.get("pageCount") or page_count,
        "description": payload.get("description") or description,
        "source": payload.get("source", "") + "+openlibrary_details",
    }
def enrich_book_data(isbn: str, base_book: dict) -> dict:
    enriched = dict(base_book)
    enriched = _enrich_with_google(isbn, enriched)

    missing_fields = [
        not enriched.get("cover"),
        not enriched.get("publisher"),
        not enriched.get("publishedDate"),
        not enriched.get("pageCount"),
        not enriched.get("language"),
        not enriched.get("categories"),
        not enriched.get("description"),
    ]
    if any(missing_fields):
        enriched = _enrich_with_openlibrary(isbn, enriched)
        enriched = _enrich_openlibrary_details(isbn, enriched)

    if not enriched.get("cover"):
        enriched["cover"] = find_cover_for_isbn(isbn)
    if not enriched.get("images") and enriched.get("cover"):
        enriched["images"] = [enriched["cover"]]

    return enriched
def _lookup_google_cover(isbn: str) -> str:
    url = f"https://www.googleapis.com/books/v1/volumes?q=isbn:{urllib.parse.quote(isbn)}"
    try:
        data = _safe_get_json(url)
    except urllib.error.HTTPError:
        return ""
    if not isinstance(data, dict) or not data.get("items"):
        return ""
    info = data["items"][0].get("volumeInfo", {})
    cover = info.get("imageLinks", {}).get("thumbnail") or info.get("imageLinks", {}).get("smallThumbnail") or ""
    if cover.startswith("http://"):
        cover = "https://" + cover[len("http://"):]
    return cover


def _isbn13_to_isbn10(isbn13: str) -> str:
    if len(isbn13) != 13 or not isbn13.startswith("978") or not isbn13.isdigit():
        return ""
    core = isbn13[3:12]
    total = 0
    for idx, ch in enumerate(core, start=1):
        total += idx * int(ch)
    remainder = total % 11
    check = "X" if remainder == 10 else str(remainder)
    return core + check


def _is_valid_cover_url(url: str) -> bool:
    req = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=8) as response:
            status_ok = getattr(response, "status", 200) == 200
            content_type = (response.headers.get("Content-Type") or "").lower()
            content_len = int(response.headers.get("Content-Length") or "0")
            return status_ok and content_type.startswith("image/") and content_len > 1000
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError, ValueError):
        return False


def find_cover_for_isbn(isbn: str) -> str:
    google_cover = _lookup_google_cover(isbn)
    if google_cover:
        return google_cover

    candidates = [f"https://covers.openlibrary.org/b/isbn/{urllib.parse.quote(isbn)}-L.jpg"]
    isbn10 = _isbn13_to_isbn10(isbn)
    if isbn10:
        candidates.append(f"https://covers.openlibrary.org/b/isbn/{urllib.parse.quote(isbn10)}-L.jpg")

    for url in candidates:
        if _is_valid_cover_url(url):
            return url
    return ""


def lookup_bnf_isbn(isbn: str) -> dict | None:
    url = (
        "https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve"
        f"&query=bib.isbn%20all%20%22{urllib.parse.quote(isbn)}%22"
        "&recordSchema=unimarcxchange&maximumRecords=1"
    )
    try:
        with urllib.request.urlopen(url, timeout=8) as response:
            xml_text = response.read().decode("utf-8", errors="replace")
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as err:
        print("Erreur BnF:", err)
        return None
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as err:
        print("XML BnF invalide:", err)
        return None

    title = ""
    authors: list[str] = []
    publisher = ""
    date = ""
    datafields = root.findall(".//{*}datafield")
    for field in datafields:
        tag = field.attrib.get("tag", "")
        subfields = field.findall("{*}subfield")
        if tag == "200":
            for sf in subfields:
                code = sf.attrib.get("code")
                text = (sf.text or "").strip()
                if code == "a" and text and not title:
                    title = text
                elif code == "f" and text:
                    authors.append(text)
        elif tag == "700":
            for sf in subfields:
                if sf.attrib.get("code") == "a" and (sf.text or "").strip():
                    authors.append((sf.text or "").strip())
        elif tag == "210":
            for sf in subfields:
                code = sf.attrib.get("code")
                text = (sf.text or "").strip()
                if code == "c" and text and not publisher:
                    publisher = text
                elif code == "d" and text and not date:
                    date = text

    authors_text = _join_unique(authors)
    if title and authors_text:
        cover_url = find_cover_for_isbn(isbn)
        return _build_payload(
            isbn,
            source="bnf",
            title=title,
            authors=authors_text,
            publisher=publisher,
            published_date=date,
            cover=cover_url,
            images=[cover_url] if cover_url else [],
        )
    return None


@app.get("/api/isbn/<isbn>")
def lookup_isbn(isbn):
    normalized_isbn = _normalize_isbn(isbn)
    print("Recherche ISBN:", normalized_isbn or isbn)

    if not normalized_isbn:
        return jsonify({"found": False, "isbn": isbn, "error": "Livre non trouvé"})

    cache = _read_isbn_cache()
    cached = cache.get(normalized_isbn)
    if isinstance(cached, dict):
        if _has_missing_enrichment_fields(cached):
            print("Cache serveur incomplet, tentative de réenrichissement:", normalized_isbn)
            refreshed = enrich_book_data(normalized_isbn, cached)
            _cache_isbn_result(normalized_isbn, refreshed)
            return jsonify(refreshed)
        print("ISBN trouvé dans cache serveur:", normalized_isbn)
        return jsonify(cached)

    bnf_data = lookup_bnf_isbn(normalized_isbn)
    if bnf_data:
        print("Source utilisée : BnF")
        enriched_bnf = enrich_book_data(normalized_isbn, bnf_data)
        _cache_isbn_result(normalized_isbn, enriched_bnf)
        return jsonify(enriched_bnf)

    google_url = f"https://www.googleapis.com/books/v1/volumes?q=isbn:{urllib.parse.quote(normalized_isbn)}"
    print("Google Books (strict):", google_url)
    try:
        google_data = _safe_get_json(google_url)
    except urllib.error.HTTPError as err:
        if err.code == 429:
            return jsonify(
                {
                    "found": False,
                    "rateLimited": True,
                    "isbn": normalized_isbn,
                    "message": "Recherche automatique temporairement limitée. Complète le livre manuellement.",
                }
            )
        raise
    if isinstance(google_data, dict) and google_data.get("totalItems", 0) > 0 and google_data.get("items"):
        info = google_data["items"][0].get("volumeInfo", {})
        title = info.get("title")
        if title:
            authors = ", ".join(info.get("authors", []))
            cover = info.get("imageLinks", {}).get("thumbnail") or info.get("imageLinks", {}).get("smallThumbnail") or ""
            if cover.startswith("http://"):
                cover = "https://" + cover[len("http://"):]
            image_list = _extract_google_images(info.get("imageLinks", {}))
            if not cover and image_list:
                cover = image_list[0]
            if not cover:
                cover = find_cover_for_isbn(normalized_isbn)
            print("Livre trouvé:", title)
            payload = _build_payload(
                normalized_isbn,
                source="google_books_strict",
                title=title,
                authors=authors,
                publisher=info.get("publisher", ""),
                published_date=info.get("publishedDate", ""),
                page_count=info.get("pageCount", 0) if isinstance(info.get("pageCount"), int) else 0,
                language=info.get("language", ""),
                categories=_join_unique(info.get("categories", []) if isinstance(info.get("categories"), list) else []),
                description=info.get("description", ""),
                cover=cover,
                images=image_list if image_list else ([cover] if cover else []),
            )
            _cache_isbn_result(normalized_isbn, payload)
            return jsonify(payload)

    google_fallback_url = f"https://www.googleapis.com/books/v1/volumes?q={urllib.parse.quote(normalized_isbn)}"
    print("Google Books (large):", google_fallback_url)
    try:
        google_fallback_data = _safe_get_json(google_fallback_url)
    except urllib.error.HTTPError as err:
        if err.code == 429:
            return jsonify(
                {
                    "found": False,
                    "rateLimited": True,
                    "isbn": normalized_isbn,
                    "message": "Recherche automatique temporairement limitée. Complète le livre manuellement.",
                }
            )
        raise
    if isinstance(google_fallback_data, dict) and google_fallback_data.get("totalItems", 0) > 0 and google_fallback_data.get("items"):
        info = google_fallback_data["items"][0].get("volumeInfo", {})
        title = info.get("title")
        if title:
            authors = ", ".join(info.get("authors", []))
            cover = info.get("imageLinks", {}).get("thumbnail") or info.get("imageLinks", {}).get("smallThumbnail") or ""
            if cover.startswith("http://"):
                cover = "https://" + cover[len("http://"):]
            image_list = _extract_google_images(info.get("imageLinks", {}))
            if not cover and image_list:
                cover = image_list[0]
            if not cover:
                cover = find_cover_for_isbn(normalized_isbn)
            print("Livre trouvé:", title)
            payload = _build_payload(
                normalized_isbn,
                source="google_books_large",
                title=title,
                authors=authors,
                publisher=info.get("publisher", ""),
                published_date=info.get("publishedDate", ""),
                page_count=info.get("pageCount", 0) if isinstance(info.get("pageCount"), int) else 0,
                language=info.get("language", ""),
                categories=_join_unique(info.get("categories", []) if isinstance(info.get("categories"), list) else []),
                description=info.get("description", ""),
                cover=cover,
                images=image_list if image_list else ([cover] if cover else []),
            )
            _cache_isbn_result(normalized_isbn, payload)
            return jsonify(payload)

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
            images = []
            if isinstance(entry.get("cover"), dict):
                images = _join_unique([entry["cover"].get("large", ""), entry["cover"].get("medium", ""), entry["cover"].get("small", "")]).split(", ")
            print("Livre trouvé:", title)
            payload = _build_payload(
                normalized_isbn,
                source="openlibrary_api_books",
                title=title,
                authors=authors,
                publisher=_join_unique(
                    [p.get("name", "") for p in entry.get("publishers", []) if isinstance(p, dict)]
                ),
                published_date=entry.get("publish_date", ""),
                page_count=entry.get("number_of_pages", 0) if isinstance(entry.get("number_of_pages"), int) else 0,
                categories=_join_unique(
                    [s.get("name", "") for s in entry.get("subjects", []) if isinstance(s, dict)]
                ),
                cover=cover,
                images=images if images and images != [""] else ([cover] if cover else []),
            )
            _cache_isbn_result(normalized_isbn, payload)
            return jsonify(payload)

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
        if not _is_valid_cover_url(cover):
            cover = find_cover_for_isbn(normalized_isbn)
        print("Livre trouvé:", title)
        payload = _build_payload(
            normalized_isbn,
            source="openlibrary_isbn",
            title=title,
            authors=authors,
            published_date=open_isbn_data.get("publish_date", ""),
            page_count=open_isbn_data.get("number_of_pages", 0)
            if isinstance(open_isbn_data.get("number_of_pages"), int)
            else 0,
            publisher=_join_unique(open_isbn_data.get("publishers", [])) if isinstance(open_isbn_data.get("publishers"), list) else "",
            cover=cover,
            images=[cover] if cover else [],
        )
        _cache_isbn_result(normalized_isbn, payload)
        return jsonify(payload)

    not_found_payload = {
        "found": False,
        "isbn": normalized_isbn,
        "message": "Livre non trouvé automatiquement. Complète le titre et l’auteur manuellement.",
    }
    _cache_isbn_result(normalized_isbn, not_found_payload)
    return jsonify(not_found_payload)

@app.get("/<path:path>")
def static_files(path):
    return send_from_directory(".", path)
