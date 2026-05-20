from __future__ import annotations

import json
import os
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


@app.get("/<path:path>")
def static_files(path):
    return send_from_directory(".", path)
