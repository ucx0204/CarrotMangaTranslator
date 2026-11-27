"""Replace a sampling grid under erased type with the pale scan that surrounds it."""
import numpy as np
from scipy.ndimage import distance_transform_edt as edt, find_objects, gaussian_filter, label
from scipy.spatial import cKDTree

from qwen_typeset_stock import caption_paper_field, has_typeset_column, opposing_light_banks, printed_components


def consecutive_square_type(ink):
    bands = []
    for box in find_objects(label(ink.any(1))[0]):
        y = box[0]
        _, x = np.where(ink[y])
        if len(x) >= 54:
            bands.append((x.min(), x.max(), y.start, y.stop-1, len(x)))
    for first, second in zip(bands, bands[1:]):
        left, right, top, bottom, area = first
        x1, x2, y1, y2, _ = second
        width, height = right-left+1, bottom-top+1
        if (14 <= width <= 50 and 14 <= height <= 54 and .65 <= width/height <= 1.5
                and 1 <= y1-bottom <= .48*height and abs(left+right-x1-x2) < .36*width
                and .72 <= (x2-x1+1)/width <= 1.35 and .72 <= (y2-y1+1)/height <= 1.35
                and .2 <= area/(width*height) <= .8):
            return True
    return False


def grid_strength(tone, selected, vertical):
    # A four-pixel tile repeats its own residual more closely than either
    # neighbouring displacement. Real regular stock has the same peak in the scan.
    detail = tone-gaussian_filter(tone, 1.35)
    if vertical:
        detail, selected = detail.T, selected.T
    correlations = []
    for shift in (3, 4, 5):
        valid = selected[:, :-shift] & selected[:, shift:]
        if valid.sum() < 85:
            return 0.
        a, b = detail[:, :-shift][valid], detail[:, shift:][valid]
        a, b = a-a.mean(), b-b.mean()
        energy = np.sqrt(np.mean(a*a)*np.mean(b*b))
        if energy < .09:
            return 0.
        correlations.append(np.mean(a*b)/energy)
    left, center, right = correlations
    return max(0., min(center, center-(left+right)/2))


def measured_texture(tone, bank):
    mass = gaussian_filter(bank.astype(float), 8)
    mean = gaussian_filter(bank*tone, 8)/np.maximum(.006, mass)
    deviation = np.sqrt(np.maximum(0, gaussian_filter(bank*tone*tone, 8)/np.maximum(.006, mass)-mean**2))

    def extend(samples):
        field = samples.copy()
        for scale in (17, 10, 6):
            weight = gaussian_filter(bank.astype(float), scale)
            value = gaussian_filter(bank*samples, scale)/np.maximum(.001, weight)
            alpha = np.clip((weight-.035)/.36, 0, 1)
            field = alpha*value+(1-alpha)*field
        return field

    return extend(np.where(mass > .03, mean, 255.)), extend(np.where(mass > .03, deviation, 0.))


def native_grain(tone, bank, targets):
    """Transfer contiguous native samples with matching brightness and grain.

    Offset the patch centers inside each cell so a dark speck cannot stamp
    itself repeatedly at the same position on a regular decoder grid.
    """
    mean, deviation = measured_texture(tone, bank)
    y, x = np.where(targets)
    by, bx = np.where(edt(bank) > 3.2)
    if len(by) < 50 or not len(x):
        return mean
    tree = cKDTree(np.column_stack((.23*by, .23*bx, 2.6*mean[by, bx], 1.3*deviation[by, bx])))
    cy, cx = np.mgrid[0:len(tone):6, 0:tone.shape[1]:6]
    random = np.random.default_rng(407)
    centers = np.column_stack((cy.ravel(), cx.ravel())) + random.uniform(-2.7, 2.7, (2, cx.size)).T
    owner = cKDTree(centers).query(np.column_stack((y, x)))[1]
    recovered = mean.copy()
    for index in np.unique(owner):
        ys, xs = y[owner == index], x[owner == index]
        row, col = np.rint(centers[index]).astype(int)
        py, px = np.clip(row, 0, len(tone)-1), np.clip(col, 0, tone.shape[1]-1)
        location = [.23*row, .23*col, 2.6*mean[py, px], 1.3*deviation[py, px]]
        candidates = tree.query(location, k=min(34, len(by)))[1]
        dy, dx = by[candidates]-row, bx[candidates]-col
        yy, xx = ys[:, None]+dy, xs[:, None]+dx
        bounded = (yy >= 0) & (xx >= 0) & (yy < len(tone)) & (xx < tone.shape[1])
        yy, xx = yy.clip(0, len(tone)-1), xx.clip(0, tone.shape[1]-1)
        visible = bounded & bank[yy, xx]
        cost = np.mean(abs(mean[yy, xx]-mean[ys, xs, None])
                       + .6*abs(deviation[yy, xx]-deviation[ys, xs, None])+96*~visible, 0)
        best = np.argmin(cost+.028*np.hypot(dy, dx))
        use = visible[:, best]
        to, frm = (ys[use], xs[use]), (yy[use, best], xx[use, best])
        recovered[to] = tone[frm]+np.clip(mean[to]-mean[frm], -4, 4)
    return recovered.clip(0, 255)


def restore_caption_grain(source, mask, result, opaque=None):
    ys, xs = np.where(mask)
    if not 440 <= len(xs) <= 30000:
        return False
    area = np.s_[max(0, ys.min()-34):ys.max()+35, max(0, xs.min()-34):xs.max()+35]
    marked = mask[area]
    if marked.size > 350000:
        return False
    original, edited = source[area], result[area]
    tone, model = original.mean(2), edited.mean(2)
    valid = np.ones_like(marked) if opaque is None else opaque[area]
    ink, _, _ = printed_components(original, marked, edited)
    dark = marked & (tone < 160)
    if (dark.sum() < 160 or ink[dark].mean() < .977
            or not (consecutive_square_type(ink) or has_typeset_column(ink))):
        return False
    distance = edt(~ink)
    clearance = edt(~((tone < 186) & ~ink) & valid)
    bank = (distance >= 3.65) & (clearance >= 2.75) & (tone >= 192) & valid
    ring = (distance >= 4) & (distance < 11) & (clearance >= 3) & valid
    if (ring.sum() < 105 or np.quantile(tone[ring], .03) < 222 or np.median(tone[ring]) < 250
            or np.quantile(np.ptp(original[ring], axis=1), .97) > 4):
        return False
    sampled = (distance <= 4) & (model > 224) & valid
    witness = bank & (distance > 5) & (distance < 18) & (tone > 224)
    if not any(grid_strength(model, sampled, axis) > .155+grid_strength(tone, witness, axis)
               for axis in (False, True)):
        return False
    # Check the proposed local paper against original pixels withheld in blocks.
    y, x = np.indices(marked.shape)
    near = (distance <= 17) & (edt(~marked) < 16)
    held = bank & near & ((x//4+3*(y//4)) % 9 == 1)
    if held.sum() < 58:
        return False
    estimated = caption_paper_field(tone, bank & ~held)
    if np.quantile(abs(estimated[held]-tone[held]), .8) > 5.2:
        return False
    supported = (gaussian_filter(bank.astype(float), 8) > .085) | (gaussian_filter(bank.astype(float), 17) > .155)
    write = near & valid & (clearance > 1.8) & supported & opposing_light_banks(tone, bank)
    changed = write & (distance > 3.1) & (distance <= 14) & (tone >= 219) & (model >= 200)
    if (changed & (abs(tone-model) >= 2)).sum() < 30:
        return False
    grain = native_grain(tone, bank & (distance >= 6.15) & (distance < 60), write & (distance < 4))
    alpha = np.clip((3.95-distance[write])/1.65, 0, 1)[:, None]
    edited[write] = np.rint((1-alpha)*original[write]+alpha*grain[write, None]).clip(0, 255)
    return True
