"""Complete a column of pale type on exposed, single-colour jacket stock."""

import numpy as np
from scipy.ndimage import distance_transform_edt, find_objects, label, maximum_filter, median_filter, minimum_filter, gaussian_filter


def registered_faces(original, mask, image):
    low = image.min(2)
    saturation = np.ptp(image, axis=2)
    groups, _ = label((low > 149) & (saturation < 84), np.ones((3, 3)))
    original_ink = (original.min(2) > 180) & (np.ptp(original, axis=2) < 65) & mask
    printed = maximum_filter(original_ink, 15)
    for index, box in enumerate(find_objects(groups), 1):
        if box is None:
            continue
        y, x = box
        height, width = y.stop-y.start, x.stop-x.start
        if min(width, height) < 2 or height > .25*len(mask) or width > .32*mask.shape[1]:
            continue
        face = groups[box] == index
        if face.sum() < 7 or not (mask[box] & face).any() or printed[box][face].mean() < .60:
            continue
        area = np.s_[max(0, y.start-11):y.stop+11, max(0, x.start-11):x.stop+11]
        distance = distance_transform_edt(groups[area] != index)
        ring = (distance > 1.3) & (distance < 5.3) & (saturation[area] > 80) & (low[area] < 124)
        if ring.sum() < 12:
            continue
        colour = np.median(image[area][ring], axis=0)
        error = np.max(abs(image[area]-colour), axis=2)
        collar = (distance > 1.8) & (distance < 5.8)
        if (error[collar] < 33).mean() >= .48 and (error[ring] < 30).mean() >= .78:
            yield (x.start, y.start, width, height), colour


def sample_surrounding_stock(image, writable, bounds, tone, weights, surface):
    left, top, right, bottom = bounds
    x, y = max(0, left-14), max(0, top-13)
    area = np.s_[y:bottom+13, x:right+14]
    region = image[area]
    toward_white = 252-tone
    opacity = np.sum((region-tone)*toward_white, axis=2)/max(1, np.sum(toward_white**2))
    mismatch = np.max(abs(region-(tone+opacity[:, :, None]*toward_white)), axis=2)
    yy, xx = np.indices(opacity.shape)
    inside = (xx+x >= left-4) & (xx+x <= right+4) & (yy+y >= top-4) & (yy+y <= bottom+4)
    ink = inside & (opacity > .025) & (mismatch < 55)
    if not ink.any():
        return
    distance = distance_transform_edt(~ink)
    blend = np.clip((3.6-distance)/1.5, 0, 1)*writable[area]
    known = (np.max(abs(region-tone), axis=2) < 14) & (distance > 2.4)
    density = gaussian_filter(known.astype(float), 6)
    field = gaussian_filter(region*known[:, :, None], (6, 6, 0))/np.maximum(.0001, density[:, :, None])
    field[density < .035] = tone
    use = blend > weights[area]
    weights[area][use] = blend[use]
    surface[area][use] = field[use]


def restore_jacket_stock(source, mask, decoded, writable):
    """Use one coherent spot colour and several original registered faces as evidence."""
    image = decoded[:, :, :3].astype(float)
    faces = list(registered_faces(source[:, :, :3].astype(float), mask & writable, image))
    weights = np.zeros(mask.shape, float)
    surface = np.zeros_like(image)
    visited = set()
    for (x, y, width, _), colour in faces:
        peers = [(b, c) for b, c in faces if np.max(abs(c-colour)) < 25
                 and abs(b[0]+b[2]/2-x-width/2) < .9*max(width, b[2])+4
                 and abs(b[1]-y) < .54*len(mask)]
        if len(peers) < 3:
            continue
        boxes = np.array([b for b, _ in peers])
        left, top = boxes[:, :2].min(0)
        right, bottom = (boxes[:, :2]+boxes[:, 2:]).max(0)
        bounds = (left, top, right, bottom)
        if bounds in visited or bottom-top < 1.4*(right-left):
            continue
        visited.add(bounds)
        tone = np.median([c for _, c in peers], axis=0)
        banks = [np.s_[max(0, top-8):top, left:right], np.s_[bottom:bottom+8, left:right],
                 np.s_[top:bottom, max(0, left-9):left], np.s_[top:bottom, right:right+9]]
        exposed = [np.mean(np.max(abs(image[bank]-tone), axis=2) < 34)
                   for bank in banks if image[bank].size]
        if sum(p > .75 for p in exposed) < 3:
            continue
        sample_surrounding_stock(image, writable, bounds, tone, weights, surface)
    used = weights > 0
    decoded[:, :, :3][used] = np.rint(image[used]+(surface[used]-image[used])*weights[used, None]).clip(0, 255)
    return bool(used.any())


def flat_jacket_paints(smooth, bank):
    spread = maximum_filter(smooth, size=(9, 9, 1)).astype('i2') - minimum_filter(smooth, size=(9, 9, 1))
    flat = bank & (spread.max(2) < 7)
    samples = smooth[flat]
    if len(samples) < 400:
        return
    red, green, blue = (samples.astype(int) // 8).T
    bins = red*1024 + green*32 + blue
    counts = np.bincount(bins, minlength=32768)
    found = []
    for code in np.argsort(-counts):
        if counts[code] < 80 or len(found) >= 9:
            break
        tone = np.median(samples[bins == code], axis=0)
        if any(np.max(abs(tone - previous)) < 19 for previous in found):
            continue
        if np.ptp(tone) < 50 and tone.mean() < 220:
            continue
        same = flat & (abs(smooth.astype(float) - tone).max(2) < 7)
        areas, count = label(same)
        if count and np.bincount(areas.ravel())[1:].max() >= 200:
            found.append(tone)
            yield tone


def letter_collar(original, stencil):
    pale = (original.min(2) > 215) & (np.ptp(original, axis=2) < 50) & stencil
    letters, count = label(pale, np.ones((3, 3)))
    sizes = np.bincount(letters.ravel(), minlength=count+1)
    small = (sizes >= 3) & (sizes <= 740)
    small[0] = False
    if small.sum() < 9:
        return
    distance = distance_transform_edt(~small[letters])
    collar = ((distance >= 2) & (distance < 6) & stencil
              & (np.ptp(original, axis=2) > 35) & (original.mean(2) < 150))
    if collar.sum() < 80:
        return
    samples = original[collar]
    red, green, blue = (samples.astype(int) // 16).T
    bins = red*256 + green*16 + blue
    pigment = np.median(samples[bins == np.bincount(bins).argmax()], axis=0)
    ink = collar & (abs(original - pigment).max(2) < 34)
    if ink.sum() >= .34 * collar.sum():
        return pigment, distance_transform_edt(~ink)


def displaced_stock(field, dy, dx):
    """Read a donor without allowing the opposite side of the crop to wrap."""
    result = np.roll(field, (-dy, -dx), axis=(0, 1))
    if dy > 0:
        result[-dy:] = False
    elif dy < 0:
        result[:-dy] = False
    if dx > 0:
        result[:, -dx:] = False
    elif dx < 0:
        result[:, :-dx] = False
    return result


def visible_stock_banks(surface, known):
    """Count directions that reach original flat paint without crossing model linework."""
    votes = np.zeros(surface.shape, dtype='u1')
    for angle in np.arange(24) * np.pi/12:
        axis = np.array((np.sin(angle), np.cos(angle)))
        path = surface.copy()
        found = np.zeros_like(path)
        for step in (3, 7, 12, 18, 26, 36, 48, 63, 81, 103):
            dy, dx = np.rint(axis*step).astype(int)
            found |= path & displaced_stock(known, dy, dx)
            path &= displaced_stock(surface, dy, dx)
        votes += found
    return votes


def restore_light_caption_stock(source, mask, repaired):
    """Remove a measured trace of coloured print on flat light paint.

    Use untouched pixels in the same connected area for the paint colour.
    Outlines separating a hat, a map or a light panel block the measurement.
    """
    original = source[:, :, :3].astype('f')
    edited = repaired[:, :, :3].astype('f')
    opaque = source[:, :, 3] == 255
    measured = letter_collar(original, mask & opaque)
    if measured is None:
        return
    pigment, near_print = measured
    distance = distance_transform_edt(~mask)
    light = (edited.min(2) > 213) & (np.ptp(edited, axis=2) < 35) & opaque
    regions, _ = label(light)
    for i, box in enumerate(find_objects(regions), 1):
        group = regions[box] == i
        if group.sum() < 600 or not (group & (near_print[box] < 86)).any():
            continue
        src, frame = original[box], edited[box]
        known = group & (near_print[box] > 49) & (distance[box] > 24) & (abs(src-frame).max(2) < 4)
        if known.sum() < 350:
            continue
        samples = src[known]
        tone = np.median(samples, axis=0)
        if (abs(samples-tone).max(1) < 4).mean() < .68:
            continue
        bank = known & (abs(src-tone).max(2) < 4)
        delta = pigment-tone
        opacity = ((frame-tone)*delta).sum(2)/(delta@delta)
        error = np.linalg.norm(frame-tone-opacity[:, :, None]*delta, axis=2)
        candidate = (group & (distance[box] < 37) & (near_print[box] < 86)
                     & (distance_transform_edt(~bank) < 160) & (abs(frame-tone).max(2) < 22))
        candidate &= ((opacity > 0) & (error < 9)) | ((distance[box] < 12) & (near_print[box] < 55) & (error < 12))
        projection = ((src-tone)*delta).sum(2)/(delta@delta)
        native_error = np.linalg.norm(src-tone-projection[:, :, None]*delta, axis=2)
        candidate &= (abs(frame-src).max(2) >= 2.5) | ((projection > .007) & (native_error < 12))
        if not candidate.any():
            continue
        candidate &= visible_stock_banks(group, bank) >= 2
        edge = np.clip((distance_transform_edt(group)-1.5)/2.4, 0, 1)
        weight = gaussian_filter(candidate.astype('f'), 1.3)*group*edge*np.clip((37-distance[box])/6, 0, 1)
        frame += weight[:, :, None]*(tone-frame)
    repaired[:, :, :3] = np.rint(edited).clip(0, 255).astype('u1')


def restore_credit_paints(source, mask, decoded):
    """Match a cleared credit to the original connected areas of flat colour.

    The printed face and its single coloured glow establish where the paper
    was obscured. Qwen supplies the paths of contours through that area.
    """
    opaque = source[:, :, 3] == 255
    y, x = np.where(mask & opaque)
    if len(x) < 400:
        return
    area = np.s_[max(0, y.min()-120):y.max()+121, max(0, x.min()-120):x.max()+121]
    stencil = mask[area] & opaque[area]
    if stencil.size > 800000:
        return
    rgb = source[area][:, :, :3]
    original, edited = rgb.astype('f'), decoded[area][:, :, :3].astype('f')
    measured = letter_collar(original, stencil)
    if measured is None:
        return
    pigment, near_print = measured
    distance = distance_transform_edt(~stencil)
    writable = opaque[area] & (distance < 28) & (near_print < 55) & (abs(original-edited).max(2) > 2)
    smooth = median_filter(rgb, size=(3, 3, 1))
    bank = (distance > 13) & (distance < 100) & opaque[area]
    score = np.zeros(stencil.shape, dtype='f')
    output = edited.copy()
    for paint in flat_jacket_paints(smooth, bank):
        delta = paint - pigment
        if np.linalg.norm(delta) < 52:
            continue
        known = ((abs(smooth.astype(float)-paint).max(2) < 7) & ((distance > 11) | (near_print > 29))
                 & (abs(edited-smooth).max(2) < 10) & opaque[area])
        if known.sum() < 180:
            continue
        depth = distance_transform_edt(~known)
        transmission = np.clip(((original-pigment)*delta).sum(2)/(delta@delta), 0, 1)
        error = np.linalg.norm(original - pigment - transmission[:, :, None]*delta, axis=2)
        underprint = (error < 24) & (transmission > .34) & (distance < 36) & (depth < 80)
        scale = (edited*paint).sum(2)/max(1, paint@paint)
        surface = ((scale > .61) & (scale < 1.21) & (depth < 110)
                   & (abs(edited-scale[:, :, None]*paint).max(2) < 20) & opaque[area])
        if np.ptp(paint) < 25:
            surface &= np.ptp(edited, axis=2) < 40
        votes = visible_stock_banks(surface, known)
        parts, _ = label(surface, np.ones((3, 3)))
        accepted = np.zeros_like(surface)
        for index, box in enumerate(find_objects(parts), 1):
            region = parts[box] == index
            patch = region & writable[box]
            if patch.sum() < 180 or (region & known[box]).sum() < 250:
                continue
            if underprint[box][patch].mean() >= .10 and (votes[box][patch] > 4).mean() >= .25:
                accepted[box] |= region
        weight = (accepted * writable * np.clip((115-depth)/10, 0, 1)
                  * np.clip(distance_transform_edt(surface)/2.3, 0, 1))
        use = weight > score
        output[use] = edited[use] + weight[use, None]*(paint-edited[use])
        score[use] = weight[use]
    if not score.any():
        return
    result = source.copy()
    result[:, :, :3] = decoded[:, :, :3]
    result[area][:, :, :3] = np.rint(output).clip(0, 255).astype('u1')
    return result
