#!/usr/bin/env python3
"""Dump an .xlsx file to text so an agent can read it (standard library only).

Usage: python3 -I dump_xlsx.py <file.xlsx> <outdir>
Writes: <outdir>/cells.txt   one line "Sheet!A1<TAB>value" per non-empty cell
        <outdir>/images.txt  embedded images: sheet, anchor cell, file path
        <outdir>/media/*     the original embedded images (agents open them with Read)
Why: specs often live in a spreadsheet with screenshots of the current behaviour, and the
screenshots usually carry information the text cells do not.
"""
import os
import sys
import zipfile
import posixpath
from xml.etree import ElementTree as ET

NS = {
    "m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "pr": "http://schemas.openxmlformats.org/package/2006/relationships",
    "xdr": "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
}


def col_name(idx):
    s = ""
    idx += 1
    while idx:
        idx, r = divmod(idx - 1, 26)
        s = chr(65 + r) + s
    return s


def rels(z, path):
    d, f = posixpath.split(path)
    rp = posixpath.join(d, "_rels", f + ".rels")
    out = {}
    if rp in z.namelist():
        for r in ET.fromstring(z.read(rp)).findall("pr:Relationship", NS):
            out[r.get("Id")] = posixpath.normpath(posixpath.join(d, r.get("Target")))
    return out


def main(src, outdir):
    os.makedirs(os.path.join(outdir, "media"), exist_ok=True)
    z = zipfile.ZipFile(src)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            shared.append("".join(t.text or "" for t in si.iter("{%s}t" % NS["m"])))
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    wb_rels = rels(z, "xl/workbook.xml")
    cells, images = [], []
    for sh in wb.find("m:sheets", NS):
        name = sh.get("name")
        sheet_path = wb_rels[sh.get("{%s}id" % NS["r"])]
        root = ET.fromstring(z.read(sheet_path))
        for c in root.iter("{%s}c" % NS["m"]):
            v = c.find("m:v", NS)
            is_ = c.find("m:is", NS)
            if c.get("t") == "s" and v is not None:
                val = shared[int(v.text)]
            elif is_ is not None:
                val = "".join(t.text or "" for t in is_.iter("{%s}t" % NS["m"]))
            elif v is not None:
                val = v.text
            else:
                continue
            if val and val.strip():
                cells.append(f"{name}!{c.get('r')}\t{val}")
        for rid, target in rels(z, sheet_path).items():
            if "/drawings/" not in target:
                continue
            drels = rels(z, target)
            droot = ET.fromstring(z.read(target))
            for anchor in list(droot):
                frm = anchor.find("xdr:from", NS)
                blip = next(anchor.iter("{%s}blip" % NS["a"]), None)
                if blip is None or frm is None:
                    continue
                media = drels.get(blip.get("{%s}embed" % NS["r"]))
                if not media or media not in z.namelist():
                    continue
                dest = os.path.join(outdir, "media", f"{name}_{os.path.basename(media)}")
                with open(dest, "wb") as f:
                    f.write(z.read(media))
                col = int(frm.find("xdr:col", NS).text)
                row = int(frm.find("xdr:row", NS).text) + 1
                images.append(f"{name}\t{col_name(col)}{row}\t{dest}")
    with open(os.path.join(outdir, "cells.txt"), "w", encoding="utf8") as f:
        f.write("\n".join(cells) + "\n")
    with open(os.path.join(outdir, "images.txt"), "w", encoding="utf8") as f:
        f.write("\n".join(images) + "\n")
    print(f"{len(cells)} cells, {len(images)} images -> {outdir}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
