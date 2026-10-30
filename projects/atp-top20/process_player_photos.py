"""Turn the downloaded player photos into small themed portraits for the explorer's profile card.

    uv run --with "rembg[cpu]" --with pillow --with "opencv-python-headless<5" python process_player_photos.py sources/photos <out_dir>

Per photo: frame Wikipedia photos on the face (OpenCV), remove the background (rembg; skipped when ATP's cut-out already has transparency), crop to
the player, trim to head-and-shoulders, posterize the luminance to a few tones and map them onto the site's
warm palette, then save a palette PNG with a hard alpha edge (a few KB each). Writes <out_dir>/<id>.png
and <out_dir>/index.json ({id: [width, credit line, source url]}); each PNG also carries
its credit as text chunks (Author, Copyright, Source, Comment).
"""
from __future__ import annotations

import json
import os
import sys

from PIL import Image, ImageFilter, ImageOps, PngImagePlugin

# dark -> light, from the site palette (see projects/atp-top20/site_theme.py)
TONES = [(0x4a, 0x2c, 0x1a), (0x8f, 0x5e, 0x3e), (0xd2, 0xa8, 0x80), (0xff, 0xf2, 0xe6)]
H = 300          # output height in px (shown at ~150 CSS px, so sharp on 2x screens)
ASPECT = 0.9     # max width / height of the crop
_session = None
# photos that don't make a usable portrait (checked by eye on a contact sheet)
SKIP = {"V232": "Commons photo has a second face beside his", "P050": "Commons photo shows two people"}


def cutout(im: Image.Image, force: bool = False) -> Image.Image:
    global _session
    a = im.getchannel("A")
    if not force and sum(a.histogram()[:16]) > 0.08 * im.width * im.height:
        return im  # already a cut-out
    from rembg import new_session, remove
    _session = _session or new_session("isnet-general-use")
    return remove(im.convert("RGB"), session=_session).convert("RGBA")


def face_crop(im: Image.Image) -> Image.Image:
    """Frame a general photo (Wikipedia) as head and shoulders around its largest face, if one is found."""
    import cv2
    import numpy as np
    g = np.asarray(im.convert("L"))
    cc = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    faces = cc.detectMultiScale(g, scaleFactor=1.1, minNeighbors=8, minSize=(max(24, g.shape[1] // 12),) * 2)
    if not len(faces):
        return im
    x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
    cx, fw = x + w / 2, w
    box = (max(0, cx - 1.5 * fw), max(0, y - 0.75 * fw), min(im.width, cx + 1.5 * fw), min(im.height, y + 2.6 * fw))
    return im.crop(tuple(round(v) for v in box))


def portrait(src: str) -> Image.Image:
    im = ImageOps.exif_transpose(Image.open(src)).convert("RGBA")
    waist_up = im.height > 1.3 * im.width  # ATP's 379x603 cut-outs; the rest are head shots or photos
    wiki = ".wiki." in src
    if wiki:
        im = face_crop(im)
        im = cutout(im.convert("RGB").convert("RGBA"), force=True)
    else:
        im = cutout(im)
    im = im.crop(im.getchannel("A").point(lambda v: 255 if v > 40 else 0).getbbox())
    # head-and-shoulders framing, so ATP's waist-up cut-outs match the head shots: waist-up figures are
    # cut at mid-chest, then the width is capped at ASPECT and centred on the head
    w, h = im.size
    ch = round(h * 0.5) if waist_up and not wiki else h
    hb = im.crop((0, 0, w, max(1, round(ch * 0.25)))).getchannel("A").point(lambda v: 255 if v > 128 else 0).getbbox()
    cx = (hb[0] + hb[2]) / 2 if hb else w / 2
    cw = min(w, round(ch * ASPECT))
    x0 = int(min(max(0, cx - cw / 2), w - cw))
    im = im.crop((x0, 0, x0 + cw, ch))
    im = im.resize((round(im.width * H / im.height), H), Image.LANCZOS)
    return im


def posterize(im: Image.Image) -> Image.Image:
    alpha = im.getchannel("A")
    mask = alpha.point(lambda v: 255 if v >= 128 else 0)
    g = im.convert("L").filter(ImageFilter.MedianFilter(3))
    # stretch contrast over the figure only, so dark and washed-out photos use all the tones
    hist = g.histogram(mask)
    total = sum(hist); acc = 0; lo = hi = None
    for v, n in enumerate(hist):
        acc += n
        if lo is None and acc >= total * 0.02: lo = v
        if hi is None and acc >= total * 0.97: hi = v
    lo, hi = lo or 0, max(hi or 255, (lo or 0) + 1)
    n = len(TONES)
    lut = [min(n - 1, max(0, int((v - lo) / (hi - lo) * n))) for v in range(256)]
    idx = g.point(lut)
    out = Image.new("P", im.size, n)  # index n = transparent
    pal = [c for t in TONES for c in t] + [0, 0, 0]
    out.putpalette(pal + [0] * (768 - len(pal)))
    out.paste(idx, mask=mask)
    out.info["transparency"] = n
    return out


def credit_line(c: dict) -> str:
    if not c: return ""
    if c.get("author") == "ATP Tour": return "Photo: ATP Tour. Background removed, posterized and recoloured."
    return f"Photo: {c['author']}, {c['license']}, via Wikimedia Commons. Background removed, posterized and recoloured."


def main(src: str, dst: str):
    os.makedirs(dst, exist_ok=True)
    manifest = json.load(open(os.path.join(src, "manifest.json")))
    done = {}
    for pid, m in sorted(manifest.items()):
        if not m.get("file") or pid in SKIP: continue
        try:
            im = posterize(portrait(os.path.join(src, m["file"])))
            c = m.get("credit") or {}
            line = credit_line(c)
            info = PngImagePlugin.PngInfo()  # the credit travels with the file as PNG text chunks
            info.add_text("Title", f"{m['name']} (posterized portrait)")
            info.add_text("Author", c.get("author", ""))
            info.add_text("Copyright", c.get("license", ""))
            info.add_text("Source", c.get("source", ""))
            info.add_text("Comment", line)
            im.save(os.path.join(dst, f"{pid}.png"), optimize=True, pnginfo=info)
            done[pid] = [im.width, line, c.get("source", "")]
        except Exception as e:  # noqa: BLE001
            print(f"  {pid} {m['name']}: {e}")
    json.dump(done, open(os.path.join(dst, "index.json"), "w"))
    kb = sum(os.path.getsize(os.path.join(dst, f"{p}.png")) for p in done) / 1024
    print(f"{len(done)} portraits, {kb:.0f} KB -> {dst}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
