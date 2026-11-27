"""Locate a surviving family of original magazine letter faces on a registered edit."""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt, find_objects, gaussian_filter, label, maximum_filter


def separated_columns(parts):
    """A coloured garment highlight alone is not a surviving text column."""
    best = []
    for face in parts:
        x, y, w, h, _, _ = face
        axis = x+w/2
        column = [p for p in parts if abs(p[0]+p[2]/2-axis) < .42*max(w, p[2])+4
                  and p[3] < 3*max(h, w) and max(p[2], p[3]) >= .28*max(w, h)]
        column.sort(key=lambda p: p[1]+p[3]/2)
        run = []
        for part in column:
            center = part[1]+part[3]/2
            if run:
                previous = run[-1]
                spacing = center-(previous[1]+previous[3]/2)
                if spacing > 2.7*max(part[2:4]+previous[2:4]):
                    run = []
            run.append(part)
            if len(run) >= 3 and center-(run[0][1]+run[0][3]/2) > max(52, 2.6*np.median([p[3] for p in run])):
                if sum(p[4] for p in run) > sum(p[4] for p in best):
                    best = run.copy()
    return best


def original_pigment(rgb, mask):
    colours = rgb.astype(int)//16
    codes = colours[:, :, 0]*256+colours[:, :, 1]*16+colours[:, :, 2]
    saturated = mask & (np.ptp(rgb, axis=2) > 94) & (rgb.max(2) > 195)
    bins = np.bincount(codes[saturated], minlength=4096)
    best = bins.argmax()
    if bins[best] >= max(110, .035*mask.sum()):
        return np.median(rgb[saturated & (codes == best)], axis=0)


def print_faces(source, mask, candidate, masthead):
    source, candidate = source.astype(float), candidate.astype(float)
    if masthead:
        colour = original_pigment(source, mask)
        if colour is None:
            return
        faces = (abs(source-colour).max(2) < 49) & (distance_transform_edt(~mask) < 4)
        seen = abs(candidate-colour).max(2) < 60
    else:
        faces = (source.min(2) > 216) & (np.ptp(source, axis=2) < 47)
        seen = (candidate.min(2) > 201) & (np.ptp(candidate, axis=2) < 59)
    groups, count = label(faces, np.ones((3, 3)))
    nearby = maximum_filter(seen.astype(np.uint8), 5) > 0
    owned = np.bincount(groups[mask], minlength=count+1)
    sizes = np.bincount(groups.ravel(), minlength=count+1)
    confirmed = []
    for index, box in enumerate(find_objects(groups), 1):
        size = sizes[index]
        if box is None or size < (55 if masthead else 14) or owned[index] < .62*size:
            continue
        sy, sx = box
        h, w = sy.stop-sy.start, sx.stop-sx.start
        if min(h, w) < 2 or max(h, w) > .72*max(mask.shape):
            continue
        part = groups[box] == index
        if nearby[box][part].mean() < .65:
            continue
        inside = seen[box][part].mean()
        if masthead and inside > .58:
            confirmed.append((sx.start, sy.start, w, h, int(size), index))
            continue
        area = np.s_[max(0, sy.start-7):sy.stop+7, max(0, sx.start-7):sx.stop+7]
        core = groups[area] == index
        reach = distance_transform_edt(~core)
        ring = (reach > 1.5) & (reach < 5)
        if not ring.any() or inside <= .46:
            continue
        original = source[area].min(2)
        if not masthead and (np.mean(np.ptp(source[area][ring], axis=1) > 38) < .21 or
                             original[core].mean()-original[ring].mean() < 22):
            continue
        a = np.stack(np.gradient(gaussian_filter(original, .72)))
        b = np.stack(np.gradient(gaussian_filter(candidate[area].min(2), .72)))
        measured = (reach < 3.7) & (np.linalg.norm(a, axis=0) > 6)
        u, v = a[:, measured], b[:, measured]
        correlation = np.sum(u*v)/max(1., np.sqrt(np.sum(u*u)*np.sum(v*v)))
        if correlation > .29:
            confirmed.append((sx.start, sy.start, w, h, int(size), index))
    keep = confirmed if masthead else separated_columns(confirmed)
    if len(keep) < 2 or sum(p[4] for p in keep) < (220 if masthead else 90):
        return
    selected = np.isin(groups, [p[5] for p in keep])
    return selected, sum(p[4] for p in keep)


def small_pigment_fragment(source, mask, candidate):
    """Track sparse remnants of a removed spot ink, including a displaced edge.

    The surrounding source must have carried significantly more of the same
    ink than the edit. A similarly coloured object merely near the selection
    provides insufficient evidence to change the registered drawing.
    """
    source, candidate = source.astype(float), candidate.astype(float)
    colour = original_pigment(source, mask)
    if colour is None:
        return
    original = abs(source-colour).max(2) < 54
    owned = original & mask
    clearance = distance_transform_edt(~owned)
    # A thin printed wedge viewed between strands may be largely antialiased.
    # Its chromatic direction survives after the saturated face is covered.
    chroma = candidate - candidate.mean(2, keepdims=True)
    spot = colour - colour.mean()
    alignment = (chroma @ spot) / np.maximum(1, np.linalg.norm(chroma, axis=2)*np.linalg.norm(spot))
    painted = ((abs(candidate-colour).max(2) < 69) |
               ((alignment > .985) & (np.ptp(candidate, axis=2) > .38*np.ptp(colour)) &
                (abs(candidate-colour).max(2) < 110)))
    if (painted & (clearance < 20)).sum() > .15*owned.sum():
        return
    support = maximum_filter(original, 15)
    groups, _ = label(painted, np.ones((3, 3)))
    remnants = []
    for i, box in enumerate(find_objects(groups), 1):
        region = groups[box] == i
        mass = int(region.sum())
        h, w = region.shape
        if mass < 12 or mass > 700 or min(w, h) > 30 or max(w, h) > 85:
            continue
        if support[box][region].mean() < .72 or np.quantile(clearance[box][region], .9) > 21:
            continue
        sy, sx = box
        vicinity = np.s_[max(0, sy.start-64):sy.stop+64, max(0, sx.start-64):sx.stop+64]
        if owned[vicinity].sum() < max(50, 2*painted[vicinity].sum()):
            continue
        remnants.append((mass, i, box))
    if not remnants:
        return
    mass, index, (sy, sx) = max(remnants, key=lambda item: item[0])
    height, width = mask.shape
    left, top = max(0, sx.start-95), max(0, sy.start-95)
    right, bottom = min(width, sx.stop+95), min(height, sy.stop+95)
    area = np.s_[top:bottom, left:right]
    core = groups[area] == index
    nearby = distance_transform_edt(~core) <= 18
    local = candidate[area]
    weak = nearby & (alignment[area] > .80) & (np.ptp(local, axis=2) > 9)
    fringe, _ = label(weak | core, np.ones((3, 3)))
    attached = np.isin(fringe, np.unique(fringe[core]))
    distance = distance_transform_edt(~attached)
    radius = max(10, min(16, round(1.7*min(sy.stop-sy.start, sx.stop-sx.start))))
    # Values above 127 select the native guide. Their upper seven bits encode
    # a soft transition on the outside of the remaining stroke and its glow.
    weight = np.where(distance < radius, .505+.495*np.clip((radius-distance)/4, 0, 1), 0.)
    return dict(x=left, y=top, width=right-left, height=bottom-top,
                score=sum(p[0] for p in remnants), fragment=mass), weight


def locate(source, mask, candidate, masthead):
    faces = print_faces(source, mask, candidate, masthead)
    if faces is None:
        return small_pigment_fragment(source, mask, candidate) if masthead else None
    selected, score = faces
    ink = (distance_transform_edt(~selected) <= 10) & (distance_transform_edt(~mask) < 5)
    y, x = np.where(ink)
    margin = max(54, min(152, round(.28*max(np.ptp(x), np.ptp(y)))))
    l, t = max(0, x.min()-margin), max(0, y.min()-margin)
    r, b = min(mask.shape[1], x.max()+margin+1), min(mask.shape[0], y.max()+margin+1)
    return dict(x=int(l), y=int(t), width=int(r-l), height=int(b-t), score=int(score)), ink[t:b, l:r]


def separated_ink_fragment(source, mask, candidate):
    """Find a broken black terminal wholly inside a removed monochrome column.

    A nearby solid must extend back into the unselected original drawing. An
    isolated dot or an intact original pen mark cannot authorize another edit.
    """
    y, x = np.where(mask)
    if (x.size < 14000 or np.ptp(y) < 400 or np.ptp(y) < 2.4*max(1, np.ptp(x))
            or np.percentile(np.ptp(source[mask], axis=1), 95) > 12):
        return
    groups, count = label(candidate[:, :, 1] < 113, np.ones((3, 3)))
    mass = np.bincount(groups.ravel(), minlength=count+1)
    native = np.bincount(groups[~mask & (source[:, :, 1] < 113)], minlength=count+1)
    fragments = []
    for index, (sy, sx) in enumerate(find_objects(groups), 1):
        size = int(mass[index])
        if not 50 <= size <= 480:
            continue
        h, w = sy.stop-sy.start, sx.stop-sx.start
        if min(w, h) < 6 or max(w, h) > 41 or not .25 < size/(w*h) < .83:
            continue
        part = groups[sy, sx] == index
        if mask[sy, sx][part].mean() < .99 or not .27 <= (source[sy, sx, 1][part] < 142).mean() <= .77:
            continue
        top, left = max(0, sy.start-32), max(0, sx.start-32)
        local = groups[top:sy.stop+32, left:sx.stop+32]
        distance = distance_transform_edt(local != index)
        anchor = (local > 0) & (mass[local] > max(1000, 8*size)) & (native[local] >= 24)
        if not np.any(anchor & (distance <= 7)):
            continue
        yy, xx = np.where(anchor & (distance <= 19))
        cx, cy = sx.start+.5*w, sy.start+.5*h
        shift = np.clip(2.5*(left+xx.mean()-cx), -.65*h, .65*h)
        fragments.append((size, cx+shift, cy, h, sx, sy))
    if not fragments:
        return
    size, cx, cy, h, sx, sy = max(fragments, key=lambda part: part[0])
    margin = max(70, min(160, round(5.6*h)))
    l, t = max(0, sx.start-margin), max(0, sy.start-margin)
    r, b = min(mask.shape[1], sx.stop+margin), min(mask.shape[0], sy.stop+margin)
    y, x = np.ogrid[t:b, l:r]
    ellipse = ((x-cx)/(2.05*h))**2 + ((y-cy)/(1.47*h))**2
    distance = distance_transform_edt(~mask[t:b, l:r])
    weight = np.clip(np.minimum((1-np.sqrt(ellipse))*h, 10.5-distance)/2, 0, 1)
    return (dict(x=l, y=t, width=r-l, height=b-t, score=sum(p[0] for p in fragments), fragment=size),
            np.where(weight > 0, .505+.495*weight, 0))


if __name__ == "__main__":
    original, matte, current, target, mode = sys.argv[1:]
    colour = lambda path: np.asarray(Image.open(path).convert("RGB"))
    source, mask, edit = colour(original), np.asarray(Image.open(matte).convert("L")) > 127, colour(current)
    if mask.shape != source.shape[:2] or source.shape != edit.shape:
        raise ValueError("The selected print and registered candidate must share their native grid")
    found = (separated_ink_fragment(source, mask, edit) if mode == "ink-terminal"
             else locate(source, mask, edit, mode == "masthead"))
    if found:
        report, local = found
        Image.fromarray(np.rint(local.astype(float)*255).astype(np.uint8)).save(Path(target))
        print(json.dumps(report))
    else:
        print("null")
