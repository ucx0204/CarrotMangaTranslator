"""Register a decoded, opaque ink silhouette to the original visible stroke banks."""

import numpy as np
from scipy.ndimage import (
    binary_opening,
    distance_transform_edt,
    gaussian_filter,
    gaussian_filter1d,
    label,
    find_objects,
    map_coordinates,
    maximum_filter1d,
    minimum_filter1d,
)


def sample(image, points):
    return map_coordinates(
        image, [points[..., 1], points[..., 0]], order=1, mode="nearest"
    )


def boundary_loops(component):
    # Clockwise pixel edges. Their centres lie on the native half-pixel grid.
    tile = np.pad(component, 1)
    h, w = tile.shape
    edges = {}
    for dx, dy, from_x, from_y, to_x, to_y in [
        (0, -1, 0, 0, 1, 0),
        (1, 0, 1, 0, 1, 1),
        (0, 1, 1, 1, 0, 1),
        (-1, 0, 0, 1, 0, 0),
    ]:
        other = np.roll(tile, (-dy, -dx), axis=(0, 1))
        y, x = np.nonzero(tile & ~other)
        start = (y + from_y) * (w + 1) + x + from_x
        end = (y + to_y) * (w + 1) + x + to_x
        for first, last in zip(start.tolist(), end.tolist()):
            edges.setdefault(first, []).append(last)
    while edges:
        start = next(iter(edges))
        points = []
        current = start
        while True:
            points.append(current)
            alternatives = edges[current]
            following = alternatives.pop()
            if not alternatives:
                del edges[current]
            current = following
            if current == start:
                break
        if len(points) >= 75:
            points = np.array(points)
            yield (
                np.column_stack((points % (w + 1), points // (w + 1))).astype(float)
                - 1.5
            )


def oriented_profiles(contour, prediction, source, clearance):
    center = gaussian_filter1d(contour, 1.7, axis=0, mode="wrap")
    tangent = np.roll(center, -4, axis=0) - np.roll(center, 4, axis=0)
    tangent /= np.maximum(0.001, np.linalg.norm(tangent, axis=1)[:, None])
    normal = np.column_stack((-tangent[:, 1], tangent[:, 0]))
    step = np.arange(-14.0, 14.01, 0.5)
    coords = center[:, None, :] + step[None, :, None] * normal[:, None, :]
    decoded, native, distance = (
        sample(im, coords) for im in (prediction, source, clearance)
    )
    left = decoded[:, (step <= -4) & (step >= -8)].mean(axis=1)
    right = decoded[:, (step >= 4) & (step <= 8)].mean(axis=1)
    sign = np.sign(right - left)
    broad_ink = (
        (abs(right - left) > 122)
        & (np.minimum(left, right) < 80)
        & (np.maximum(left, right) > 183)
    )
    derivative = (decoded[:, 2:] - decoded[:, :-2]) * sign[:, None]
    central = np.flatnonzero(abs(step[1:-1]) <= 3)
    edge = central[np.argmax(derivative[:, central], axis=1)] + 1
    derivative = (native[:, 2:] - native[:, :-2]) * sign[:, None]
    row = np.arange(len(center))
    best = np.zeros(len(row))
    shifts = np.zeros(len(row))
    for half_pixels in range(-18, 19):
        pos = edge + half_pixels
        before = np.clip(pos - 8, 0, len(step) - 1)
        after = np.clip(pos + 8, 0, len(step) - 1)
        lo, hi = native[row, before], native[row, after]
        clear = (
            (distance[row, pos] > 3)
            & (distance[row, before] > 2.2)
            & (distance[row, after] > 2.2)
        )
        difference = abs(lo - decoded[row, edge - 8]) + abs(hi - decoded[row, edge + 8])
        weight = (
            np.maximum(0, derivative[row, pos - 1])
            * np.clip((hi - lo) * sign / 160, 0, 1)
            * np.clip(1 - difference / 115, 0, 1)
            * clear
            * broad_ink
        )
        improve = weight > best
        best[improve] = weight[improve]
        shifts[improve] = half_pixels * 0.5
    return center, tangent, normal, broad_ink, best, shifts


def fit_offsets(shifts, confidence):
    displacement = np.zeros(len(shifts))
    for sigma in (28.0, 17.0, 9.0, 4.0):
        smooth = lambda a: gaussian_filter1d(a, sigma, mode="wrap")
        mass = smooth(confidence)
        mean = smooth(confidence * shifts) / np.maximum(0.00001, mass)
        scatter = smooth(confidence * (shifts - mean) ** 2) / np.maximum(0.00001, mass)
        strength = np.clip(mass / 0.2, 0, 1) * np.clip((6 - scatter) / 4, 0, 1)
        displacement += strength * (mean - displacement)
    return displacement


def supported_offsets(profile, clearance):
    center, _, _, broad_ink, best, shifts = profile
    observed = best > 28
    if observed.sum() < 7:
        return
    mass = gaussian_filter1d(observed.astype(float), 2.2, mode="wrap")
    mean = gaussian_filter1d(shifts * observed, 2.2, mode="wrap") / np.maximum(
        0.0001, mass
    )
    consistent = observed & (mass > 0.43) & (abs(shifts - mean) < 1.25)
    nearby = sample(clearance, center) < 27
    relevant = nearby & consistent & (abs(shifts) > 1)
    if relevant.sum() < 6:
        return
    confidence = consistent * np.minimum(1, best / 70)
    # Hold out contiguous runs along the native pen. They must predict the
    # correction before we use the remaining visible ends to fit the final curve.
    hold = (np.arange(len(center)) // 4) % 3 == 1
    verify = relevant & hold
    if verify.sum() < 2 or (relevant & ~hold).sum() < 4:
        return
    test = fit_offsets(shifts, confidence * ~hold)
    if np.mean(abs(test[verify] - shifts[verify])) > 0.62 * np.mean(
        abs(shifts[verify])
    ):
        return
    offsets = fit_offsets(shifts, confidence)
    eligible = broad_ink & (abs(offsets) > 0.35)
    # A junction can imitate displacement when the direction of the edge changes.
    # Require a stable run before transferring any measured offset across the print.
    spread = maximum_filter1d(offsets, 17, mode="wrap") - minimum_filter1d(
        offsets, 17, mode="wrap"
    )
    plateau = (abs(offsets) >= 2.15) & (spread <= 1.35) & eligible
    if plateau.sum() < 11:
        return
    reach = maximum_filter1d(plateau.astype("float32"), 17, mode="wrap")
    offsets *= gaussian_filter1d(reach, 2.4, mode="wrap")
    return offsets, eligible & (abs(offsets) > 0.40)


def accumulate_warp(profile, offsets, use, fields):
    center, tangent, normal = profile[:3]
    horizontal, vertical, total = fields
    h, w = total.shape
    for j in np.flatnonzero(use):
        position = center[j] + offsets[j] * normal[j]
        l, t = np.maximum(0, np.floor(position - 17).astype(int))
        r, b = np.minimum([w, h], np.ceil(position + 18).astype(int))
        yy, xx = np.mgrid[t:b, l:r]
        x, y = xx - position[0], yy - position[1]
        along = x * tangent[j, 0] + y * tangent[j, 1]
        across = x * normal[j, 0] + y * normal[j, 1]
        weight = np.exp(-0.5 * ((along / 2.1) ** 2 + (across / 7.3) ** 2))
        horizontal[t:b, l:r] += weight * offsets[j] * normal[j, 0]
        vertical[t:b, l:r] += weight * offsets[j] * normal[j, 1]
        total[t:b, l:r] += weight


def registered_decode(source, decoded, stencil):
    if source.shape != decoded.shape or source.shape[:2] != stencil.shape:
        raise ValueError("Native silhouette inputs differ in size")
    if stencil.size > 1_500_000 or not np.any(stencil) or np.all(stencil):
        return
    # Require native monochrome print. Chromatic edges do not have the same ink profile.
    if np.percentile(np.ptp(source[::3, ::3, :3], axis=2), 98) > 5:
        return
    gray = lambda rgb: (
        rgb[:, :, :3].astype("float32") @ np.array([0.299, 0.587, 0.114], np.float32)
    )
    native = gaussian_filter(gray(source), 0.72)
    raw = gaussian_filter(gray(decoded), 0.75)
    y, x = np.ogrid[-3:4, -3:4]
    silhouettes = binary_opening(raw < 121, x * x + y * y <= 9)
    ids, _ = label(silhouettes)
    boxes = find_objects(ids)
    clearance = distance_transform_edt(~stencil).astype("float32")
    fields = [np.zeros(stencil.shape, "float32") for _ in range(3)]
    for index, box in enumerate(boxes, 1):
        if not np.any(stencil[box]):
            continue
        comp = ids[box] == index
        if comp.sum() < 240 or not np.any(stencil[box] & comp):
            continue
        for loop in boundary_loops(comp):
            if len(loop) > 24000:
                continue
            loop += [box[1].start, box[0].start]
            distance = sample(clearance, loop)
            if distance.min() > 1 or distance.max() < 3:
                continue
            profile = oriented_profiles(loop, raw, native, clearance)
            fitted = supported_offsets(profile, clearance)
            if fitted is not None:
                accumulate_warp(profile, *fitted, fields)
    shift_x, shift_y, weight = fields
    if not np.any(weight):
        return
    denom = np.maximum(2.8, weight)
    y, x = np.nonzero((abs(shift_x) + abs(shift_y)) > 0.05 * denom)
    points = np.column_stack(
        (x - shift_x[y, x] / denom[y, x], y - shift_y[y, x] / denom[y, x])
    )
    result = decoded.copy()
    for channel in range(3):
        result[y, x, channel] = np.rint(
            sample(decoded[:, :, channel].astype("float32"), points)
        ).clip(0, 255)
    native_gray, before, after = (gray(im) for im in (source, decoded, result))
    # Verify the proposed raster displacement against nearby unprinted material.
    # This catches changes that fit an edge centre but distort its neighbouring pen.
    witness = (clearance > 3) & (clearance < 45) & (abs(before - after) > 6)
    if not witness.any():
        return
    before_error = abs(native_gray - before) * witness
    after_error = abs(native_gray - after) * witness
    confidence = np.zeros(stencil.shape, np.float32)
    for i, scale in enumerate((5, 10, 16, 24)):
        weight = gaussian_filter(witness.astype("float32"), scale)
        original = gaussian_filter(before_error, scale)
        adjusted = gaussian_filter(after_error, scale)
        improvement = (original - adjusted) / np.maximum(1, original)
        agreement = (
            np.clip((original / np.maximum(weight, 0.0001) - 9) / 9, 0, 1)
            * np.clip((improvement - 0.15) / 0.36, 0, 1)
            * np.clip(weight * scale**2 / 1.4, 0, 1)
        )
        confidence = np.maximum(confidence, agreement * (1 - i / scale**2))
    moved_edge = (before < 116) != (after < 116)
    if not moved_edge.any():
        return
    radius = distance_transform_edt(~moved_edge)
    confidence *= np.clip((5 - radius) / 2.5, 0, 1)
    result = (
        np.rint(
            decoded.astype("float32")
            + (result.astype("float32") - decoded) * confidence[:, :, None]
        )
        .clip(0, 255)
        .astype("uint8")
    )
    if np.any(result != decoded):
        return result


def run(source_path, mask_path, decoded_path, destination):
    from PIL import Image

    with Image.open(source_path) as image:
        if "A" in image.getbands() and image.getchannel("A").getextrema()[0] < 255:
            return False
        source = np.array(image.convert("RGB"))
    with Image.open(mask_path) as image:
        stencil = np.array(image.convert("L")) > 127
    with Image.open(decoded_path) as image:
        decoded = np.array(image.convert("RGB"))
        alpha = image.getchannel("A") if "A" in image.getbands() else None
    result = registered_decode(source, decoded, stencil)
    if result is None:
        return False
    output = Image.fromarray(result)
    if alpha is not None:
        output.putalpha(alpha)
    output.save(destination)
    return True


if __name__ == "__main__":
    import sys

    print("applied" if run(*sys.argv[1:]) else "unchanged")
