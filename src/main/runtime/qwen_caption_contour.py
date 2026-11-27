"""Register the edge of a screened drawing beside a vertical caption on bare paper."""
from pathlib import Path
from runpy import run_path

import numpy as np
from scipy.ndimage import distance_transform_edt as edt, label, map_coordinates, median_filter


def paper_side(tone, box):
    left, top, right, bottom = box
    if left < 24 or right+24 >= tone.shape[1]:
        return 0
    a = tone[top:bottom+1, left-24:left-5]
    b = tone[top:bottom+1, right+4:right+23]

    def blank(paper, drawing):
        return (np.mean(paper == 255) > .95 and np.quantile(paper, .03) > 248
                and np.mean(drawing < 241) > .35 and np.mean(drawing < 148) > .035)

    if blank(a, b):
        return -1
    return 1 if blank(b, a) else 0


def interrupted_edge(ends, model, ink_distance, bottom):
    # Two native tips have to agree with the pen independently predicted by Qwen.
    # A second strand entering the same gap from another angle stays separate.
    candidates = []
    decoded_distance = edt(model > 177)
    for first in ends:
        p, v, width, length, _ = first
        if p[1] < bottom-40 or length < 16:
            continue
        for second in ends:
            q, w, size, reach, _ = second
            span = np.linalg.norm(q-p)
            if (reach < 16 or abs(width-size) >= .65 or not 7.2 < span < 24
                    or q[1]-p[1] < .78*span):
                continue
            axis = (q-p)/span
            if v @ axis <= .84 or -w @ axis <= .81:
                continue
            t = np.linspace(0, 1, round(4*span)+1)[:, None]
            path = ((2*t**3-3*t*t+1)*p+(t**3-2*t*t+t)*span*v
                    + (-2*t**3+3*t*t)*q+(t*t-t**3)*span*w)
            position = path.T[::-1]
            distance = map_coordinates(ink_distance, position, order=1)
            support = np.mean(map_coordinates(decoded_distance, position, order=1) < 1.65)
            if support > .76 and distance.min() <= 4.5 and distance.max() <= 13:
                candidates.append((support-.014*span, first, second, path))
    candidates.sort(key=lambda item: item[0], reverse=True)
    if candidates and (len(candidates) == 1 or candidates[0][0]-candidates[1][0] > .13):
        return candidates[0][1:]


def drawn_edge(tone, box):
    left, top, right, bottom = box
    start, end = max(6, left+8), min(tone.shape[1]-16, right+30)
    rows = np.arange(max(0, top-7), min(len(tone), bottom+9))
    positions = []
    for y in rows:
        line = tone[y]
        candidates = []
        for x in range(start, end):
            if (line[x:x+3].min() < 162 and np.sum(line[x+3:x+16] < 238) >= 4
                    and line[x-5:x].mean() > 224):
                candidates.append(x+np.argmin(line[x:x+3]))
                break
        if not candidates:
            candidates = [x for x in range(start, end)
                          if np.sum(line[x:x+16] < 243) >= 11 and line[x-6:x].mean() > 239]
        positions.append(candidates[0] if candidates else np.nan)
    positions = np.array(positions)
    known = np.isfinite(positions)
    if known.mean() < .75:
        return
    return median_filter(np.interp(np.arange(len(tone)), rows[known], positions[known]), 5)


def close_caption_nibs(source, result, marked, valid, ink_distance, box, native_ends, contours):
    """Join short breaks where an exposed native nib and the predicted pen agree."""
    model = result.mean(2)
    ends = contours["visible_ends"](model, np.full_like(model, 4))
    pairs = []
    for i, first in enumerate(ends):
        p, v, width, length, _ = first
        if length < 16 or width > 2.6:
            continue
        for second in ends[i+1:]:
            q, w, other_width, reach, _ = second
            span = np.linalg.norm(q-p)
            if reach < 16 or abs(width-other_width) > .7 or not 3 <= span <= 8.5:
                continue
            axis = (q-p)/span
            if min(v @ axis, -w @ axis) < .86:
                continue
            if not any(np.linalg.norm(start-end) <= 2 and direction @ tangent > .86
                       for start, direction, *_ in native_ends for end, tangent in ((p, v), (q, w))):
                continue
            t = np.linspace(0, 1, round(7*span)+1)[:, None]
            path = ((2*t**3-3*t*t+1)*p+(t**3-2*t*t+t)*span*v
                    + (-2*t**3+3*t*t)*q-(t**3-t*t)*span*w)
            sample = path[len(path)//5:-len(path)//5].T[::-1]
            if (np.min(map_coordinates(ink_distance, sample, order=1)) <= 5
                    and np.max(map_coordinates(model, sample, order=1)) > 202):
                pairs.append((first, second, path))
    if not pairs:
        return False
    # The paper bank was measured on the original scan. Clear pale decoder haze
    # only outside the screened silhouette, well away from its antialiased pen.
    edge = drawn_edge(model, box)
    if edge is not None:
        rows, columns = np.indices(marked.shape)
        paper = source.mean(2)
        lo, top, _, bottom = box
        bank = np.median(paper[:, lo-24:lo-5], axis=1)[:, None]
        area = (valid & (edt(~marked) < 17) & (rows >= top-3) & (rows <= bottom+3)
                & (columns < edge[:, None]-1.2) & (edt(model >= 222) > 2.3)
                & (model > 237) & (bank >= 252))
        measured = np.where((ink_distance > 4) & (paper >= 248), paper, bank)
        result[area] = np.rint(measured[area, None])
    for first, second, path in pairs:
        contours["draw_measured_pen"](result, result, path, first, second, valid)
    return True


def repair_edge(source, mask, result, valid, box):
    gray, model = source.mean(2), result.mean(2)
    labels, count = label(gray < 158, np.ones((3, 3)))
    areas = np.bincount(labels.ravel(), minlength=count+1)
    owned = np.bincount(labels[mask], minlength=count+1)
    faded = np.bincount(labels[model-gray > 31], minlength=count+1)
    type_parts = (areas >= 3) & (owned > .58*areas) & (faded > .34*areas)
    type_parts[0] = False
    if np.count_nonzero(type_parts & (areas > 75)) < 3 or np.count_nonzero(type_parts & (areas < 65)) < 3:
        return False
    ink = type_parts[labels]
    bottom = np.where(ink)[0].max()
    distance = edt(~ink)
    contours = run_path(str(Path(__file__).with_name("qwen-reconnect-balloon.py")))
    ends = contours["visible_ends"](gray, distance)
    closed = close_caption_nibs(source, result, mask, valid, distance, box, ends, contours)
    gap = interrupted_edge(ends, model, distance, bottom)
    if gap is None:
        return closed
    stable = (owned < .48*areas) & (areas >= 65)
    stable[0] = False
    pen = edt(~stable[labels])
    rows, columns = np.indices(mask.shape)
    near = edt(~mask)
    foot = (near < 20) & (distance > 1.6) & (pen+.25 < distance) & (pen < 9) & (rows >= bottom-18) & valid
    foot &= (gray < model+2) | ((rows > bottom+3) & (distance > 7))
    if (foot & (pen == 0) & (model-gray > 32)).sum() < 7:
        return closed
    edge = drawn_edge(model, box)
    if edge is None:
        return closed
    alpha = np.clip((distance-1.4)/1.8, 0, 1)*np.clip((distance-pen+.4)/2.5, 0, 1)*np.clip((8-pen)/2, 0, 1)
    result[foot] = np.rint(result[foot]+alpha[foot, None]*(source[foot].astype(float)-result[foot]))
    # Keep the isolated protruding nib and every original line in the white margin.
    exterior = ((near < 17) & (rows >= box[1]-4) & (rows <= box[3]+3)
                & (columns < edge[:, None]-3.2) & (pen > 2.1) & (model >= 205) & valid)
    fade = (np.clip((edge[:, None]-3.2-columns)/3, 0, 1)*np.clip((pen-2.1)/1.9, 0, 1)
            * np.clip((model-205)/26, 0, 1))
    result[exterior] = np.rint(result[exterior]+fade[exterior, None]*(255.-result[exterior]))
    first, second, path = gap
    contours["draw_measured_pen"](source, result, path, first, second, valid & (near < 20))
    return True


def restore_open_caption_edge(source, mask, result, opaque):
    y, x = np.where(mask)
    if (not 350 <= len(x) <= 14000 or not 85 <= np.ptp(y) <= 340 or not 19 <= np.ptp(x) <= 125
            or np.ptp(y) < 2.2*np.ptp(x)):
        return False
    bounds = np.s_[max(0, y.min()-36):y.max()+37, max(0, x.min()-48):x.max()+49]
    marked, original, edited = mask[bounds], source[bounds], result[bounds]
    valid = np.ones_like(marked) if opaque is None else opaque[bounds]
    y, x = np.where(marked)
    if np.quantile(np.ptp(original[marked], axis=1), .99) > 5:
        return False
    box = (x.min(), y.min(), x.max(), y.max())
    side = paper_side(original.mean(2), box)
    if not side:
        return False
    if side == 1:
        width = marked.shape[1]
        original, marked, edited, valid = (item[:, ::-1] for item in (original, marked, edited, valid))
        box = (width-1-box[2], box[1], width-1-box[0], box[3])
    return repair_edge(original, marked, edited, valid, box)
