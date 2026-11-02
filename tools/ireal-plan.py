#!/usr/bin/env python3
"""Map the requested jazz-standard titles to iReal Pro's library row indices.

iReal Pro's library table is 1702 rows, sorted naturally by title, and the
AX row index maps 1:1 onto `SELECT ZTITLE FROM ZSONG ORDER BY ZTITLE` in
iRealPro.sqlite (verified 2026-11-02: row 301 = Caravan, 452 = Doxy,
760 = In a Sentimental Mood, 777 = Infant Eyes).

So the mapping is a SORT, not a search: the database gives the sorted
titles, and the row index is the 1-based position in that list.

The database lives at:
  ~/Library/Containers/com.massimobiolcati.irealbookmac/Data/Library/
    Application Support/iReal Pro/iRealPro.sqlite

Natural sort (the way the table actually sorts) puts:
  - digits before letters
  - ' before letters (so "St. Thomas" before "Stella")
  - case-insensitive
"""
import os
import re
import sqlite3
import sys

DB = os.path.expanduser(
    "~/Library/Containers/com.massimobiolcati.irealbookmac/Data/Library/"
    "Application Support/iReal Pro/iRealPro.sqlite"
)

TARGETS = """Wave, Desafinado, Corcovado, One Note Samba, A Night in Tunisia, Take Five,
Afro Blue, Spain, So What, Impressions, Equinox, Nardis, Cantaloupe Island,
Watermelon Man, Song for My Father, Stolen Moments, Footprints, Maiden Voyage,
Recorda Me, Blue Bossa, Autumn Leaves, All the Things You Are, Stella by
Starlight, There Will Never Be Another You, My Funny Valentine, Body and Soul,
Misty, Round Midnight, Blue in Green, Solar, Four, Freddie Freeloader, All
Blues, Milestones, Giant Steps, Naima, Mr. P.C., Countdown, Moment's Notice,
Lazy Bird, Central Park West, My Favorite Things, In a Sentimental Mood, Lush
Life, Sophisticated Lady, Take the A Train, Satin Doll, Caravan, Mood Indigo,
Prelude to a Kiss, Chelsea Bridge, A Flower Is a Lovesome Thing, Goodbye Pork
Pie Hat, Better Git It in Your Soul, Haitian Fight Song, Pithecanthropus
Erectus, Moanin', Blues March, Along Came Betty, Whisper Not, Killer Joe, I
Remember Clifford, Stablemates, Doxy, Oleo, Airegin, St. Thomas, Pent-Up House,
The Eternal Triangle, Donna Lee, Confirmation, Anthropology, Ornithology,
Scrapple from the Apple, Yardbird Suite, Billie's Bounce, Now's the Time, Au
Privave, Relaxin' at Camarillo, Groovin' High, Salt Peanuts, Hot House, Con
Alma, Manteca, Tin Tin Deo, Woody 'n You, Birk's Works, Ceora, The Sidewinder,
The Rumproller, Cornbread, Search for the New Land, Inner Urge, Serenity, Black
Narcissus, Isotope, Dolphin Dance, Speak No Evil, Witch Hunt, Infant Eyes"""


def natural_key(s):
    """Natural sort key: digit runs compare numerically, everything else
    case-insensitively, and punctuation sorts before letters."""
    parts = re.split(r"(\d+)", s or "")
    key = []
    for p in parts:
        if p.isdigit():
            key.append((0, int(p), ""))
        elif p:
            key.append((1, 0, p.lower()))
    return key


# Titles the user spelled differently from how iReal stores them.
# MEASURED 2026-11-02 — each of these is a real row in the library.
ALIASES = {
    "recorda me": "Recordame",
    "the eternal triangle": "Eternal Triangle",
    "the sidewinder": "Sidewinder",
    "the rumproller": "Rumproller",
    "milestones": "Milestones (New)",
}


def norm(s):
    """Fold the punctuation and spacing differences between what the user
    typed and what iReal stores."""
    s = (s or "").lower()
    s = s.replace("’", "'").replace("‘", "'")
    s = s.replace("“", '"').replace("”", '"')
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def main():
    targets = [t.strip() for t in TARGETS.replace("\n", " ").split(",") if t.strip()]
    print(f"targets: {len(targets)}")

    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    # MAIN LIBRARY ONLY. The database holds all three playlists
    # (1702 songs + Jazz 1460 + Brazilian 220 = 3382 rows), but the table
    # shows the 1702 that are in no playlist.
    rows = con.execute(
        "SELECT ZTITLE FROM ZSONG WHERE ZPLAYLIST IS NULL AND ZTITLE IS NOT NULL"
    ).fetchall()
    con.close()
    titles = [r[0] for r in rows]
    print(f"db songs: {len(titles)}")

    # The table's order is the natural sort of the titles.
    ordered = sorted(titles, key=natural_key)
    index = {}
    for i, t in enumerate(ordered, start=1):
        index.setdefault(norm(t), (i, t))

    print(f"\n{'row':>5}  {'requested':<32} {'iReal title':<32} status")
    print("-" * 86)
    found, missing = [], []
    for t in targets:
        key = norm(t)
        hit = index.get(key)
        if hit is None and key in ALIASES:
            hit = index.get(norm(ALIASES[key]))
            if hit:
                print(f"  (alias: {t!r} -> {ALIASES[key]!r})")
        if hit:
            row, actual = hit
            found.append((row, t, actual))
            mark = "ok" if norm(t) == norm(actual) else "fuzzy"
            print(f"{row:>5}  {t[:32]:<32} {actual[:32]:<32} {mark}")
        else:
            missing.append(t)
            print(f"{'-':>5}  {t[:32]:<32} {'-- NOT IN LIBRARY --':<32} MISSING")

    print(f"\nfound {len(found)} / {len(targets)}")
    if missing:
        print(f"missing ({len(missing)}):")
        for m in missing:
            print(f"  - {m}")

    # Write the batch plan: one "row<TAB>filename" per line.
    out = os.path.expanduser("~/Documents/ireal-export/plan.tsv")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        f.write("# row\tfile\ttitle\n")
        for row, req, actual in sorted(found):
            safe = re.sub(r"[^A-Za-z0-9 .'\-]+", "", actual).strip() or "untitled"
            f.write(f"{row}\t{safe}.wav\t{actual}\n")
    print(f"\nplan -> {out} ({len(found)} rows)")


if __name__ == "__main__":
    main()
