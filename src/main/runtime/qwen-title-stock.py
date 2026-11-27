"""Render two rows of printed type in the measured tonal range of their illustrated stock."""
import sys

import numpy as np
from PIL import Image
from scipy.ndimage import binary_fill_holes, distance_transform_edt, label
from scipy.sparse import coo_matrix
from scipy.sparse.linalg import spsolve


def byte(values):
    return np.rint(np.clip(values, 0, 255)).astype(np.uint8)


def divider(gray, mask, bounds, dark_fraction):
    top, bottom, left, right = bounds
    y = np.arange(len(gray))
    columns = np.arange(gray.shape[1])
    dark = np.flatnonzero((dark_fraction > .7) & (y > top+9) & (y < bottom-9))
    for group in np.split(dark, np.flatnonzero(np.diff(dark) > 1)+1):
        if not 1 <= len(group) <= 5:
            continue
        row = group[np.argmin(np.median(gray[group], axis=1))]
        above = np.median(gray[row-7:row-4], axis=0)
        below = np.median(gray[row+5:row+8], axis=0)
        fraction = np.arange(1, 12)[:, None]/12
        plain = above*(1-fraction) + below*fraction
        transmission = gray[row-5:row+6]/np.maximum(1, plain)
        witness = ((columns > left) & (columns < right) & (above > 155) & (below > 155)
                   & (gray[row] < 20) & (np.min(gray[row-7:row-4], axis=0) > 145)
                   & (np.min(gray[row+4:row+7], axis=0) > 145))
        held = (columns//9) % 7 == 2
        if (witness & ~held).sum() < 80 or (witness & held).sum() < 15:
            continue
        profile = np.median(transmission[:, witness & ~held], axis=1)
        error = np.mean(abs(transmission[:, witness & held] - profile[:, None]), axis=0)
        core = profile < .93
        if np.median(error) > .035 or profile.min() >= .17 or core.sum() > 6:
            continue
        near = distance_transform_edt(~witness) < 39
        return row, profile, core, witness, near & mask[row-5:row+6].any(axis=0)


def distributed_ink(gray, mask, left, right):
    parts, count = label(mask & (gray < 155), structure=np.ones((3, 3)))
    if count < 4:
        return False
    area = np.bincount(parts.ravel(), minlength=count+1)
    ids = np.flatnonzero((area > 32) & (area < .32*mask.sum()))
    ids = ids[ids != 0]
    if len(ids) < 4:
        return False
    _, x = np.where(np.isin(parts, ids))
    return np.ptp(x) > .40*(right-left)


def measure(source, mask):
    ys, xs = np.nonzero(mask)
    if len(xs) < 1500 or len(xs) > 155000 or mask.size > 950000:
        return
    top, bottom, left, right = ys.min(), ys.max(), xs.min(), xs.max()
    if right-left < 190 or bottom-top < 64 or right-left < 1.75*(bottom-top):
        return
    if np.percentile(np.ptp(source, axis=2)[mask], 98) > 5:
        return
    gray = source[:, :, 1]
    rows = np.arange(len(gray))
    dark = (gray[:, left:right+1] < 126).mean(axis=1)
    first = rows[(rows < top) & (dark > .63)]
    last = rows[(rows > bottom) & (dark > .63)]
    if not len(first) or not len(last):
        return
    start, end = first[-1], last[0]
    boundary = divider(gray, mask, (top, bottom, left, right), dark)
    if boundary is None:
        return
    middle = boundary[0]
    for section in (slice(start+2, middle-3), slice(middle+4, end-1)):
        if not distributed_ink(gray[section], mask[section], left, right):
            return
    y, x = np.indices(mask.shape)
    clear = distance_transform_edt(~mask)
    layers, count = label(((gray > 141) | mask) & (y > start) & (y < end), structure=np.ones((3, 3)))
    rim = (clear > 2.5) & (clear < 6.5)
    hits = np.bincount(layers[rim], minlength=count+1)
    ids = np.flatnonzero(hits > .11*rim.sum())
    stock = binary_fill_holes(np.isin(layers, ids[ids != 0])) | mask
    if np.percentile(np.ptp(source, axis=2)[stock], 99) > 5:
        return
    known = stock & (clear > 4) & (gray > 142) & (y > start+3) & (y < end-3)
    if known.sum() < 6000:
        return
    fold = (x//26 + 3*(y//19)) % 5
    partitions = [gray[known & (fold == i)] for i in range(5)]
    if min(map(len, partitions)) < 300:
        return
    limits = np.array([np.percentile(part, [2, 99]) for part in partitions])
    low, high = np.median(limits, axis=0)
    if not (154 <= low <= 213 and high >= 231 and high-low >= 28):
        return
    if np.ptp(limits[:, 0]) >= 8 or np.ptp(limits[:, 1]) >= 7:
        return
    scale = (high-low)/246
    return scale, low-5*scale, stock, boundary


def integrate(source, guide, mask, weight, anchor):
    # Fix native samples on the boundary of every island. Solving a small
    # sparse system joins the decoder's gradients without outlining glyphs.
    y, x = np.nonzero(mask)
    ids = np.full(mask.shape, -1, np.int32)
    index = np.arange(len(y))
    ids[mask] = index
    guide = guide.astype(float)
    rhs = anchor*guide[mask]
    degree = np.full(len(y), anchor)
    rows, cols, values = [], [], []
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        xx, yy = x+dx, y+dy
        valid = (xx >= 0) & (yy >= 0) & (xx < mask.shape[1]) & (yy < mask.shape[0])
        idx, xx, yy = index[valid], xx[valid], yy[valid]
        target = ids[yy, xx]
        inside = target >= 0
        rhs[idx] += weight*(guide[y[valid], x[valid]] - guide[yy, xx])
        rhs[idx[~inside]] += source[yy[~inside], xx[~inside]]
        degree[idx] += 1
        rows.append(idx[inside])
        cols.append(target[inside])
        values.append(-np.ones(inside.sum()))
    matrix = coo_matrix((np.concatenate([*values, degree]),
                         (np.concatenate([*rows, index]), np.concatenate([*cols, index])))).tocsc()
    result = source.copy()
    result[mask] = byte(spsolve(matrix, rhs))
    return result


def render(mode, source, mask, candidate, measurement):
    scale, offset, stock, boundary = measurement
    gray = source[:, :, 1]
    original = np.where(stock, byte((gray.astype(float)-offset)/scale), gray)
    if mode == "source":
        return np.repeat(original[:, :, None], 3, axis=2)
    guide = candidate[:, :, 1]
    if mode == "guide":
        fitted = integrate(original, guide, mask, .78, .002)
        result = np.where(mask, byte(.7*fitted + .3*guide), original)
        return np.repeat(result[:, :, None], 3, axis=2)
    if mode != "finish":
        raise ValueError("Unknown title stock operation")
    plain, decoded = gray.copy(), byte(guide.astype(float)*scale+offset)
    row, profile, core, observed, area = boundary
    # Remove the thin source rule from both gradient fields during the solve.
    # Otherwise its almost black ink bleeds down from the boundary of a glyph.
    first, last = np.flatnonzero(core)[[0, -1]]+row-5
    columns = np.arange(mask.shape[1])
    above = np.maximum(0, first - np.arange(2, 21))
    below = np.minimum(mask.shape[0]-1, last + np.arange(2, 21))
    def paper_bank(rows):
        clear = ~mask[rows] & (gray[rows] > 142)
        closest = rows[np.argmax(clear, axis=0)]
        tone = np.where(clear.any(axis=0), gray[closest, columns], decoded[rows[0]])
        return closest, tone
    top_y, top_tone = paper_bank(above)
    bottom_y, bottom_tone = paper_bank(below)
    for y in range(first-1, last+2):
        fraction = (y-row+6)/12
        decoded[y] = byte((1-fraction)*decoded[row-6]+fraction*decoded[row+6])
        if first <= y <= last:
            blend = (y-top_y)/(bottom_y-top_y)
            plain[y] = byte((1-blend)*top_tone+blend*bottom_tone)
    result = integrate(plain, decoded, mask, .86, .0003)
    result[mask] = np.maximum(result[mask], byte(offset-5))
    for j in np.flatnonzero(core):
        y = row-5+j
        cut = mask[y] & area
        result[y, cut] = byte(result[y, cut]*profile[j])
        result[y, mask[y] & observed] = gray[y, mask[y] & observed]
    output = source.copy()
    output[mask] = result[mask, None]
    return output


if __name__ == "__main__":
    source_file, mask_file, candidate_file, output_file, mode = sys.argv[1:]
    with Image.open(source_file) as image:
        source_pixels = np.array(image.convert("RGB"))
        alpha = image.getchannel("A") if "A" in image.getbands() else None
    with Image.open(mask_file) as image:
        mask_pixels = np.array(image.convert("L")) > 127
    with Image.open(candidate_file) as image:
        candidate_pixels = np.array(image.convert("RGB"))
    if source_pixels.shape != candidate_pixels.shape or mask_pixels.shape != source_pixels.shape[:2]:
        raise ValueError("Qwen title mask and source must share the native pixel grid")
    measurement = measure(source_pixels, mask_pixels) if alpha is None or alpha.getextrema()[0] == 255 else None
    if measurement is None:
        print("unchanged")
    else:
        restored = Image.fromarray(render(mode, source_pixels, mask_pixels, candidate_pixels, measurement))
        if alpha is not None:
            restored.putalpha(alpha)
        restored.save(output_file)
        print("applied")
