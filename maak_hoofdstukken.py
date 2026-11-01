#!/usr/bin/env python3
"""
Maakt een chapters.json in een boekmap, zodat de app de hoofdstukken kent.

Gebruik (één boekmap, met al de audiobestanden erin):
    python3 maak_hoofdstukken.py "C:/Boeken/De Hobbit"

Vereist: ffprobe (onderdeel van FFmpeg).
Zet daarna chapters.json naast de audiobestanden. Kies bij het downloaden in de app
alle audiobestanden + chapters.json tegelijk, met dezelfde titel.
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

AUDIO = {".mp3", ".m4b", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".wav"}


def natural_key(text):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", text)]


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    if not shutil.which("ffprobe"):
        sys.exit("ffprobe niet gevonden. Installeer FFmpeg en zet het in je PATH.")

    folder = Path(sys.argv[1])
    files = sorted((f for f in folder.iterdir() if f.is_file() and f.suffix.lower() in AUDIO),
                   key=lambda f: natural_key(f.name))
    if not files:
        sys.exit(f"Geen audiobestanden gevonden in {folder}")

    out = []
    for f in files:
        res = subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json", "-show_chapters", str(f)],
            capture_output=True, text=True,
        )
        chapters = json.loads(res.stdout or "{}").get("chapters", [])
        if chapters:
            for i, ch in enumerate(chapters):
                title = (ch.get("tags") or {}).get("title") or f"Hoofdstuk {i + 1}"
                out.append({"title": title, "file": f.name, "start": float(ch["start_time"])})
        else:
            # geen hoofdstukken in dit bestand: het bestand zelf is het hoofdstuk
            out.append({"title": f.stem, "file": f.name, "start": 0})

    target = folder / "chapters.json"
    target.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{len(out)} hoofdstukken opgeslagen in {target}")


if __name__ == "__main__":
    main()
