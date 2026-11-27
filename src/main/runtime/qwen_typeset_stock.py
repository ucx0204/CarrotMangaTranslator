"""Recover the measured paper beneath isolated dialogue type in a Qwen edit."""
import numpy as np
from scipy.ndimage import distance_transform_edt, find_objects, gaussian_filter, label, maximum_filter1d, minimum_filter
from scipy.spatial import cKDTree


def restore_colour_strap(source, mask, result, opaque):
    """A translucent printed strap shows the original picture through its ink.
    Sample the same saturated stock above and below pale selected lettering."""
    y, x = np.where(mask)
    if len(x) < 40 or np.ptp(x) < 4*np.ptp(y) or np.ptp(y) > 110:
        return False
    box = np.s_[max(0, y.min()-14):y.max()+15, max(0, x.min()-14):x.max()+15]
    rgb = source[box][:, :, :3].astype(float)
    edited = result[box][:, :, :3]
    marked = mask[box]
    distance = distance_transform_edt(~marked)
    high, low = rgb.max(2), rgb.min(2)
    saturation = high-low
    ring = (distance < 13) & (distance > 1)
    selected = ring & (saturation > 68)
    if selected.sum() < max(45, .43*ring.sum()):
        return False
    sampling = np.median(rgb[selected], axis=0)
    chroma = rgb-rgb.mean(2)[:, :, None]
    difference = np.linalg.norm(chroma-(sampling-sampling.mean()), axis=2)
    paper = selected & (difference < 34)
    if paper.sum() < .73*selected.sum():
        return False
    base = np.median(rgb[paper], axis=0)
    dark, light = np.argmin(base), np.argmax(base)
    spread = base[light]-base[dark]
    if spread < 79:
        return False
    faces = ((distance < 7) & (rgb[:, :, dark] > base[dark]+max(36, .2*spread))
             & (saturation < .85*spread) & (high >= base.max()-30))
    groups, _ = label(faces, np.ones((3, 3)))
    sizes = np.bincount(groups.ravel())
    accepted = (sizes >= 2) & (sizes <= max(1200, .6*len(x)))
    accepted[0] = False
    faces = accepted[groups]
    if faces.sum() < 9:
        return False
    reach = distance_transform_edt(~faces)
    match = ((difference < 33) & (saturation > .65*spread)
             & (rgb[:, :, dark] < base[dark]+26) & (abs(rgb[:, :, light]-base[light]) < 57))
    rows = np.arange(len(rgb))[:, None]
    ys = np.where(marked)[0]
    upper = gaussian_filter((match & (rows < ys.min())).astype(float), (15, 8))
    lower = gaussian_filter((match & (rows > ys.max())).astype(float), (15, 8))
    bounded = (upper > .032) & (lower > .032)
    if (bounded & faces).sum() < .65*faces.sum():
        return False
    donors = match & (reach > 3.5)
    def field(scale):
        mass = gaussian_filter(donors.astype(float), scale)
        total = gaussian_filter(rgb*donors[:, :, None], (*scale, 0))
        return total/np.maximum(.000001, mass[:, :, None]), mass
    fine, support = field((3.5, 4))
    coarse, density = field((8, 7))
    distant, _ = field((13, 8))
    weight = np.clip(support/.24, 0, 1)[:, :, None]
    target = fine*weight+coarse*(1-weight)
    fallback = np.clip((.10-density)/.09, 0, 1)[:, :, None]
    target += (distant-target)*fallback
    clean = donors & (difference < 24) & (reach > 4.4)
    target[clean] = rgb[clean]
    if np.count_nonzero(bounded & faces & (np.max(abs(edited-target), axis=2) > 29)) < max(4, faces.sum()*.02):
        return False
    blend = (bounded * np.clip((9-reach)/2.5, 0, 1)*np.clip((10-distance)/3, 0, 1)*opaque[box])
    write = blend > 0
    edited[write] = np.rint(edited[write]+blend[write, None]*(target[write]-edited[write])).clip(0, 255)
    return bool(write.any())


def printed_components(source, mask, prediction):
    tone = source.mean(2)
    dark = tone < 191
    labels, _ = label(dark, np.ones((3, 3)))
    free = distance_transform_edt(~dark)
    candidates = []
    for index, box in enumerate(find_objects(labels), 1):
        if box is None:
            continue
        y, x = box
        height, width = y.stop-y.start, x.stop-x.start
        if max(height, width) > 86 or min(width, height) < 2:
            continue
        stroke = labels[box] == index
        if not 4 <= stroke.sum() <= 6000:
            continue
        selected = mask[box][stroke].mean()
        if selected < .23:
            continue
        around = np.s_[max(0, y.start-17):y.stop+17, max(0, x.start-17):x.stop+17]
        radius = distance_transform_edt(labels[around] != index)
        bank = (radius > 5.5) & (radius < 13.5) & (free[around] > 2.6)
        samples = source[around][bank]
        if len(samples) < 23:
            continue
        low, lower_decile = np.quantile(samples.mean(1), [.05, .10])
        if low <= 211 or lower_decile <= 218 or np.quantile(np.ptp(samples, axis=1), .9) > 20:
            continue
        cy, cx = y.start+(height-1)/2, x.start+(width-1)/2
        by, bx = np.where(bank)
        angle = np.arctan2(by+around[0].start-cy, bx+around[1].start-cx)
        directions = np.bincount(((angle+np.pi)*6/np.pi).astype(int).clip(0, 11), minlength=12)
        if (directions >= 4).sum() < 7:
            continue
        erased = np.mean(prediction[box].mean(2)[stroke] > 215)
        stock = np.median(samples, axis=0).round().astype(np.uint8)
        flat = low >= 246 and stock.min() >= 250
        candidates.append((index, box, cx, cy, flat, stock, selected > .52 and erased > .56))
    ink = np.zeros_like(mask)
    flat_ink = np.zeros_like(mask)
    colour = np.zeros_like(source)
    anchors = [(x, y) for _, _, x, y, _, _, accepted in candidates if accepted]
    for index, box, x, y, flat, stock, accepted in candidates:
        # Koharu may clip the first letter of a vertical column. Require an
        # independently erased neighbour at the same horizontal position.
        if not accepted and not (flat and any(abs(x-px) <= 10 and 9 < abs(y-py) < 50 for px, py in anchors)):
            continue
        stroke = labels[box] == index
        ink[box] |= stroke
        if flat:
            flat_ink[box] |= stroke
            colour[box][stroke] = stock
    return ink, flat_ink, colour


def grain_samples(source, field, bank, targets):
    """Transfer small patches of fine residual from unprinted native stock."""
    native = gaussian_filter(source.astype("f"), (1.65, 1.65, 0))
    grain = source - native
    clearance = distance_transform_edt(bank)
    by, bx = np.where(clearance > 3.7)
    yy, xx = np.where(targets)
    if len(bx) < 16 or not len(xx):
        return field
    result = field.copy()
    level = native.mean(2)
    tree = cKDTree(np.column_stack((by, bx)))
    for ty, tx in np.unique(np.column_stack((yy//4, xx//4)), axis=0):
        y, x = 4*ty, 4*tx
        ids = tree.query_ball_point([y+1.5, x+1.5], 32)
        if not ids:
            continue
        cy, cx = by[ids], bx[ids]
        safe = (cy >= 2) & (cx >= 2) & (cy < len(bank)-3) & (cx < bank.shape[1]-3)
        cy, cx = cy[safe], cx[safe]
        if not len(cx):
            continue
        patch = result[y:y+4, x:x+4]
        cost = .16*np.hypot(cy-y-1.5, cx-x-1.5) + 1.2*abs(level[cy, cx]-np.median(patch.mean(2)))
        best = np.argmin(cost)
        sy, sx = cy[best]-1, cx[best]-1
        patch += grain[sy:sy+patch.shape[0], sx:sx+patch.shape[1]]
    return result


def reversed_type_faces(tone, selected, base):
    bright = tone > max(125, base.mean()+81)
    labels, _ = label(bright, np.ones((3, 3)))
    confirmed = np.zeros_like(selected)
    count = 0
    for index, box in enumerate(find_objects(labels), 1):
        if box is None:
            continue
        stroke = labels[box] == index
        if not 4 <= stroke.sum() <= 2200 or max(stroke.shape) > 82 or selected[box][stroke].mean() < .84:
            continue
        confirmed[box] |= stroke
        count += 1
    inside = bright & selected
    if count < 6 or inside.sum() < .15*selected.sum() or (confirmed & inside).sum() < .94*inside.sum():
        return
    return confirmed, bright & ~confirmed


def smooth_dark_field(source, samples):
    weights = gaussian_filter(samples.astype(float), 11.)
    values = gaussian_filter(source*samples[:, :, None], (11., 11., 0))
    return values/np.maximum(.00001, weights[:, :, None]), weights


def restore_reversed_type_stock(source, mask, prediction, opaque):
    """Register light type on dark printed stock against its exposed colour and grain."""
    y, x = np.where(mask)
    if not 180 <= len(x) <= 100000:
        return False
    region = np.s_[max(0, y.min()-27):y.max()+28, max(0, x.min()-27):x.max()+28]
    native = source[region][:, :, :3]
    marked, edited = mask[region], prediction[region][:, :, :3]
    valid = np.ones_like(marked) if opaque is None else opaque[region]
    if marked.size > 750000 or not valid[marked].all():
        return False
    distance = distance_transform_edt(~marked)
    original = native.astype(float)
    gray = original.mean(2)
    ring = (distance >= 5.5) & (distance < 19) & valid
    if ring.sum() < 120:
        return False
    base = np.median(original[ring], axis=0)
    low, high = np.percentile(gray[ring], [4, 96])
    if base.max() > 80 or high-low > 13 or high > 83:
        return False
    faces = reversed_type_faces(gray, marked, base)
    if faces is None:
        return False
    ink, other = faces
    if np.mean(edited[ink & marked].mean(1) < high+13) < .96:
        return False
    known = (distance >= 5.5) & (distance <= 26) & valid & (np.max(abs(original-base), axis=2) <= 17)
    yy, xx = np.indices(marked.shape)
    holdout = known & ((yy//7 + xx//5) % 4 == 0)
    if holdout.sum() < 99:
        return False
    tested, _ = smooth_dark_field(original, known & ~holdout)
    if np.quantile(np.max(abs(original[holdout]-tested[holdout]), axis=1), .90) > 4.6:
        return False
    fit, weights = smooth_dark_field(original, known)
    write = (distance <= 9) & valid & (marked | np.any(edited != native, axis=2))
    if other.any():
        write &= distance_transform_edt(~other) > 2.5
    if not write.any() or weights[write].min() < .025:
        return False
    registered = grain_samples(native, fit, known, write)
    alpha = np.clip((8-distance_transform_edt(~ink))/2.5, 0, 1)[:, :, None]
    target = np.rint(np.clip(alpha*registered+(1-alpha)*original, 0, 255)).astype('u1')
    if np.percentile(np.max(abs(edited[write].astype(float)-target[write]), axis=1), 75) < 2:
        return False
    edited[write] = target[write]
    return True


def wholly_surrounded_wash(source, mask, ink, distance):
    # All selected dark pigment must belong to measured letters. Validate the
    # surrounding stock outside their optical outline, including the gaps.
    tone = source.mean(2)
    dark = mask & (tone < 191)
    if dark.sum() < 115 or ink[dark].mean() < .995 or distance[mask].max() > 5.25:
        return False
    if np.any((distance > 2) & (distance < 9) & (tone < 191)):
        return False
    bank = (distance > 7) & (distance < 26)
    if bank.sum() < 280:
        return False
    valid = (tone > 205) & (np.ptp(source, axis=2) < 21)
    if np.mean(valid[bank]) < .968:
        return False
    low, middle, high = np.quantile(tone[bank], [.04, .50, .90])
    return low >= 215 and middle < 249 and high-low > 4


def wash_under_print(source, result, distance, clearance, isolated):
    tone = source.mean(2)
    exposed = distance > (7 if isolated else 6)
    known = (exposed & (clearance > (3.5 if isolated else 2.6))
             & (tone > (205 if isolated else 212)) & (np.ptp(source, axis=2) < 24))
    mass = gaussian_filter(known.astype("f"), 8)
    purity = mass / np.maximum(.001, gaussian_filter(exposed.astype("f"), 8))
    evidence = np.clip((purity-.81)/.14, 0, 1)*np.clip((mass-.08)/.13, 0, 1)
    desired = (distance < 14) & (clearance > 3) & (clearance+.85 > distance) & (evidence > .12)
    if not desired.any():
        return
    weighted = source.astype("f")*known[:, :, None]
    field = None
    support = np.zeros_like(mass)
    for sigma in ((24, 13, 7, 3, 1.7) if isolated else (14, 8, 4, 2)):
        density = gaussian_filter(known.astype("f"), sigma)
        surface = gaussian_filter(weighted, (sigma, sigma, 0))/np.maximum(.0001, density[:, :, None])
        alpha = np.clip((density-.075)/.34, 0, 1)[:, :, None]
        field = surface if field is None else alpha*surface + (1-alpha)*field
        support = np.maximum(support, density)
    native = grain_samples(source, field, known & (distance > 8) & (clearance > 4.2), desired)
    blend = (np.clip((9.5-distance)/3.5, 0, 1) if isolated else np.clip((8-distance)/2.3, 0, 1))[:, :, None]
    stock = (1-blend)*source + blend*np.clip(native, 0, 255)
    if isolated:
        # The scan establishes the unprinted material on every side. Outside
        # the measured press shoulder it also supplies the exact native pixels.
        result[:] = np.rint(stock).astype(np.uint8)
        return
    weight = (evidence*np.clip((support-.09)/.15, 0, 1)*np.clip((14-distance)/2.5, 0, 1)
              * np.clip((clearance-distance-.3)/3, 0, 1))
    mix_stock(result, stock, weight)


def mix_stock(result, stock, weight):
    write = weight > 0
    opacity = weight[write, None]
    result[write] = np.rint((1-opacity)*result[write] + opacity*stock[write]).clip(0, 255).astype(np.uint8)


def flat_under_print(source, result, ink, colours):
    distance, nearest = distance_transform_edt(~ink, return_indices=True)
    tone = source.mean(2)
    drawing = (tone < 191) & ~ink
    clearance = distance_transform_edt(~drawing) if drawing.any() else np.full_like(tone, np.inf)
    tonal_bank = (distance > 4.6) & (tone < 238) & (clearance > 2)
    separation = distance_transform_edt(~tonal_bank) if tonal_bank.any() else np.full_like(tone, np.inf)
    # A stroke can pass through a balloon outline and continue on a black panel.
    # The exposed fill on either side distinguishes that case from white paper.
    exposed = distance > 4.6
    visible = gaussian_filter(exposed.astype("f"), 5)
    light = gaussian_filter((exposed & (tone >= 245)).astype("f"), 5)/np.maximum(.001, visible)
    interior = np.clip((light-.59)/.28, 0, 1)
    fade = (np.clip((15-distance)/4, 0, 1)*np.clip((clearance-1.4)/2.1, 0, 1)
            * np.clip((separation-.6)/2.8, 0, 1)*interior)
    weight = fade*np.clip((9-distance)/3, 0, 1)*np.clip((clearance-distance*.22-.7)/2.2, 0, 1)
    mix_stock(result, colours[tuple(nearest)], weight)
    pristine = ((distance > 7) & (distance < 22) & (tone >= 245) & (minimum_filter(tone, 3) >= 241)
                & (clearance > 2.5) & (separation > 1) & (interior > .98))
    result[pristine] = source[pristine]


def restore_registered_pause_marks(source, mask, prediction):
    """Remove a dark stroke still registered to short vertical print followed by a measured ellipsis."""
    y, x = np.where(mask)
    if not 120 <= len(x) <= 6500 or not 48 <= np.ptp(y) <= 200 or not 18 <= np.ptp(x) <= 115:
        return False
    if np.mean(np.ptp(source[mask], axis=1) > 14) > .02:
        return False
    gray = source.mean(2)
    edited = prediction.mean(2)
    groups, _ = label((gray < 80) & mask, np.ones((3, 3)))
    parts = []
    for index, box in enumerate(find_objects(groups), 1):
        rows, cols = np.where(groups[box] == index)
        if len(cols) >= 6:
            parts.append((rows.mean()+box[0].start, cols.mean()+box[1].start,
                          np.ptp(rows)+1, np.ptp(cols)+1, len(cols), index))
    if not 6 <= len(parts) <= 15:
        return False
    parts.sort()
    dots = np.array(parts[-3:])
    pitch = np.diff(dots[:, 0])
    if (max(dots[:, 2:4].ravel()) > 11 or max(dots[:, 4]) > 70 or min(pitch) < 4
            or max(pitch) > 21 or np.ptp(pitch) > .45*pitch.mean()
            or np.ptp(dots[:, 1]) > .42*pitch.mean()
            or dots[0, 0] < y.min()+.63*np.ptp(y)
            or dots[0, 0]-parts[-4][0] < pitch.mean()):
        return False
    pristine = (~mask) & (distance_transform_edt(gray >= 80) > 2) & (gray > 158)
    weight = gaussian_filter(pristine.astype(float), 4)
    paper = gaussian_filter(gray*pristine, 4) / np.maximum(.00001, weight)
    applied = False
    for _, _, _, _, area, index in parts:
        core = groups == index
        remaining = core & (edited < 125)
        if remaining.sum() < max(5, .19*area):
            continue
        distance = distance_transform_edt(~core)
        ring = ~mask & (distance > 3.5) & (distance < 12)
        if ring.sum() < 15 or np.median(gray[ring]) < 226:
            continue
        alpha = np.clip((5.3-distance)/1.7, 0, 1)*mask
        target = np.maximum(prediction, np.clip(paper, 0, 255)[:, :, None])
        prediction[:] = np.rint(prediction+(target-prediction)*alpha[:, :, None])
        applied = True
    return applied


def erased_dark_type(tone, marked, edited):
    labels, count = label(tone < 174, np.ones((3, 3)))
    sizes = np.bincount(labels.ravel())
    accepted = np.zeros(count+1, bool)
    for number, box in enumerate(find_objects(labels), 1):
        if box is None or max(labels[box].shape) > 66 or sizes[number] < 7:
            continue
        face = labels[box] == number
        accepted[number] = (marked[box][face].mean() > .62 and (edited[box][face] > 215).mean() > .88
                            and np.quantile(tone[box][face], .35) < 68)
    if accepted.sum() >= 4:
        return accepted[labels]


def has_typeset_column(ink):
    # Read the visible pitch and width of two adjacent glyphs in the same
    # column. A diagonal handwritten sound can also leave pale decode noise.
    for center in range(18, ink.shape[1]-18, 4):
        stripe = ink[:, center-18:center+19]
        rows, _ = label(maximum_filter1d((stripe.sum(1) >= 2).astype("u1"), 3))
        previous = None
        for box in find_objects(rows):
            yy, xx = np.where(stripe[box])
            if len(xx) < 42:
                continue
            xx += center-18
            yy += box[0].start
            left, right, top, bottom = xx.min(), xx.max(), yy.min(), yy.max()
            width, height = right-left+1, bottom-top+1
            mid = (left+right)/2
            if (not 12 <= height <= 51 or not 11 <= width <= 44 or not .57 <= width/height <= 1.55
                    or abs(mid-center) >= 6.8 or (left == center-18 and right == center+18)):
                continue
            extra = (ink[top:bottom+1, max(0, center-27):center-18].sum()
                     + ink[top:bottom+1, center+19:center+28].sum())
            if extra > .28*len(xx):
                continue
            if previous is not None:
                base, old_width, old_height, old_mid = previous
                if (1 <= top-base <= .5*max(height, old_height) and min(width, old_width) >= .70*max(width, old_width)
                        and min(height, old_height) >= .72*max(height, old_height)
                        and abs(mid-old_mid) <= .19*max(width, old_width)):
                    return True
            previous = bottom, width, height, mid
    return False


def opposing_light_banks(tone, bank):
    mass = gaussian_filter(bank.astype(float), 3)
    samples = (mass > .44) & (gaussian_filter((bank & (tone > 223)).astype(float), 3) > .89*mass)
    banks = []
    for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
        seen = np.zeros_like(bank)
        for step in (8, 13, 19, 26, 33, 40):
            rows = np.arange(bank.shape[0])+dy*step
            cols = np.arange(bank.shape[1])+dx*step
            valid = ((rows >= 0) & (rows < bank.shape[0]))[:, None] & ((cols >= 0) & (cols < bank.shape[1]))
            seen |= valid & samples[np.ix_(rows.clip(0, bank.shape[0]-1), cols.clip(0, bank.shape[1]-1))]
        banks.append(seen)
    return (banks[0] & banks[1]) | (banks[2] & banks[3])


def caption_paper_field(tone, bank):
    fit = None
    for scale in (23, 12, 6, 3):
        mass = gaussian_filter(bank.astype(float), scale)
        value = gaussian_filter(tone*bank, scale)/np.maximum(.0001, mass)
        weight = np.clip((mass-.08)/.49, 0, 1)
        fit = value if fit is None else weight*value+(1-weight)*fit
    return fit


def validate_caption_stock(original, bank, distance, clearance, near):
    y, x = np.indices(bank.shape)
    hold = bank & (distance < 44) & (distance >= 7) & (clearance > 5) & near & ((x//5+3*(y//5)) % 10 == 4)
    if hold.sum() < 100 or np.quantile(np.ptp(original[hold], axis=1), .99) > 5:
        return False
    tone = original.mean(2)
    train = bank & ~hold
    tested = gaussian_filter(tone*train, 5)/np.maximum(.0001, gaussian_filter(train.astype(float), 5))
    error = abs(tested[hold]-tone[hold])
    return np.quantile(error, .80) <= 13 and np.median(error) <= 4.5


def restore_shaded_type_imprint(source, mask, prediction, opaque=None):
    """Remove a decoded shadow where exposed original paper between printed strokes proves it is new."""
    rows, cols = np.where(mask)
    if not 500 <= len(rows) <= 70000:
        return False
    box = np.s_[max(0, rows.min()-59):rows.max()+60, max(0, cols.min()-59):cols.max()+60]
    marked = mask[box]
    if marked.size > 640000:
        return False
    original, edited = source[box], prediction[box]
    tone, model = original.mean(2), edited.mean(2)
    ink = erased_dark_type(tone, marked, model)
    if ink is None or not has_typeset_column(ink):
        return False
    distance = distance_transform_edt(~ink)
    foreign = (tone < 174) & ~ink
    valid = np.ones_like(marked) if opaque is None else opaque[box]
    clearance = distance_transform_edt(~foreign & valid)
    bank = valid & (distance >= 4.4) & (clearance >= 3.6) & (tone >= 185)
    mean = gaussian_filter(tone*bank, 7)/np.maximum(.0001, gaussian_filter(bank.astype(float), 7))
    facing = opposing_light_banks(tone, bank) & (mean > 232) & (gaussian_filter(bank.astype(float), 19) > .10)
    witness = (facing & (distance > 3.1) & (distance < 11) & (clearance > 2.5) & (tone >= 236)
               & (tone-model > 2.8))
    if witness.sum() < 45:
        return False
    field = caption_paper_field(tone, bank)
    witness &= field-model > 2.5
    if witness.sum() < 45 or np.quantile(np.ptp(original[witness], axis=1), .98) > 5:
        return False
    near = distance_transform_edt(~witness) < 55
    if not validate_caption_stock(original, bank, distance, clearance, near):
        return False
    write = near & (distance <= 12) & (clearance > 2) & facing & valid
    variance = gaussian_filter(np.where(bank, (tone-mean)**2, 0), 6)/np.maximum(.0001, gaussian_filter(bank.astype(float), 6))
    rgb = np.broadcast_to(field[:, :, None], original.shape).copy()
    textured = variance > 1.7**2
    grain = grain_samples(original.astype(float), rgb, bank & (distance >= 6) & (clearance >= 5),
                          write & (distance <= 4.8) & textured)
    alpha = np.clip((5-distance)/1.85, 0, 1)[:, :, None]
    target = (1-alpha)*original+alpha*np.where(textured[:, :, None], grain, rgb)
    weight = np.clip((12-distance)/3, 0, 1)*np.clip((clearance-1.5)/2.3, 0, 1)*write
    mix_stock(edited, target, weight)
    return True


def retained_reading_strokes(tone, model, marked, flat):
    labels, _ = label(flat, np.ones((3, 3)))
    main, bars, readings = [], [], []
    for index, box in enumerate(find_objects(labels), 1):
        if box is None:
            continue
        face = labels[box] == index
        y, x = np.where(face)
        h, w = np.ptp(y)+1, np.ptp(x)+1
        if (tone[box][face] < 110).sum() < 3:
            continue
        center = (x.mean()+box[1].start, y.mean()+box[0].start, w, h)
        erased = (model[box][face] > 235).mean()
        if 8 <= w <= 44 and 8 <= h <= 51 and len(x) >= 28 and erased > .85:
            main.append(center)
        if 12 <= w <= 40 and 2 <= h <= 6 and w >= 3*h and len(x) >= 25 and erased > .9:
            bars.append(center)
        if w <= 12 and 2 <= h <= 13 and 5 <= len(x) <= 76 and erased >= .44 and marked[box][face].mean() >= .45:
            readings.append((index, *center))
    if len(main) < 2 or len(readings) < 2:
        return
    # A horizontal ideograph such as 一 can be a full character in a vertical column.
    anchors = main+[(cx, cy, w, w) for cx, cy, w, _ in bars
                    if any(abs(cx-x) < .33*w and 10 < abs(cy-y) < 1.9*w for x, y, _, _ in main)]
    accepted = []
    for index, cx, cy, w, h in readings:
        neighbor = any(3 < abs(cx-x) <= 22 and abs(cy-y) < .93*height and max(w, h) < .80*max(width, height)
                       for x, y, width, height in anchors)
        peer = any(other != index and abs(cx-x) < 6 and abs(cy-y) <= 23 for other, x, y, _, _ in readings)
        if neighbor and peer:
            accepted.append(index)
    if accepted:
        return np.isin(labels, accepted)


def erase_reading_residue(source, tone, model, marked, prediction, ink, flat, valid):
    if flat.sum() < 150 or flat.sum() < .8*ink.sum():
        return False
    reading = retained_reading_strokes(tone, model, marked, flat & valid)
    if reading is None or not (reading & (model < 220) & (model-tone < 75)).any():
        return False
    distance = distance_transform_edt(~reading)
    clearance = distance_transform_edt(~((tone < 191) & ~ink))
    bank = ((distance > 3) & (distance < 8) & (clearance > 4)
            & (distance_transform_edt(~(ink & ~reading)) > 3) & valid)
    if (bank.sum() < 30 or np.quantile(tone[bank], .03) < 246 or np.median(tone[bank]) < 252
            or (np.ptp(source[bank], axis=1) > 3).mean() > .015):
        return False
    weight = np.clip((5.5-distance)/2, 0, 1)*(clearance > 2)*valid
    stock = np.broadcast_to(np.median(source[bank], axis=0), source.shape)
    mix_stock(prediction, stock, weight)
    return True


def preserve_pen_beside_column(source, tone, model, marked, prediction, ink, valid):
    if not has_typeset_column(ink):
        return False
    labels, _ = label((tone < 191) & valid, np.ones((3, 3)))
    separate = np.zeros_like(marked)
    to_print = distance_transform_edt(~ink)
    rows = np.arange(len(marked))
    for number, box in enumerate(find_objects(labels), 1):
        if box is None or min(box[0].start, box[1].start) < 2:
            continue
        y, x = np.where(labels[box] == number)
        if not 26 <= len(x) <= 400 or not 20 <= max(np.ptp(x), np.ptp(y)) <= 80:
            continue
        y, x = y+box[0].start, x+box[1].start
        covered = marked[y, x]
        if not .12 <= covered.mean() <= .44 or ink[y, x].any() or ((model[y, x]-tone[y, x] > 30) & ~covered).sum() < 4:
            continue
        thin, long = np.linalg.eigvalsh(np.cov(x, y))
        if long < 13*max(.1, thin) or thin > 7 or np.quantile(to_print[y, x][~covered], .65) < 7:
            continue
        # Its exposed length has to extend sideways beyond the registered
        # column. Partially selected letter stems within the column stay erased.
        column = np.nonzero(ink[abs(rows-y.mean()) <= 9])[1]
        if len(column) and np.min(abs(np.median(x[~covered])-column)) >= 3:
            separate[y, x] = True
    if not separate.any():
        return False
    distance = distance_transform_edt(~separate)
    clearance = distance_transform_edt(~((tone < 191) & ~separate))
    stock = (distance > 2.5) & (distance < 8) & (clearance > 2.4) & valid
    if stock.sum() < 45 or np.quantile(tone[stock], .2) < 244 or np.quantile(np.ptp(source[stock], axis=1), .99) > 5:
        return False
    weight = np.clip((4.7-distance)/2.2, 0, 1)*np.clip((clearance-distance+.3)/2.4, 0, 1)*valid
    mix_stock(prediction, source, weight)
    return True


def restore_unenclosed_readings_and_pen(source, mask, result, opaque):
    """Retain independent drawing and finish small readings beside native vertical print."""
    y, x = np.where(mask)
    if len(x) < 180 or not 25 <= np.ptp(y) <= 270 or not 10 <= np.ptp(x) <= 200:
        return False
    box = np.s_[max(0, y.min()-35):y.max()+36, max(0, x.min()-35):x.max()+36]
    source, mask, result = source[box], mask[box], result[box]
    if np.quantile(np.ptp(source[mask], axis=1), .98) > 5:
        return False
    valid = np.ones_like(mask) if opaque is None else opaque[box]
    ink, flat, colours = printed_components(source, mask, result)
    tone, model = source.mean(2), result.mean(2)
    readings = erase_reading_residue(source, tone, model, mask, result, ink, flat, valid)
    paper = flat.any() and np.array_equal(flat, ink) and has_typeset_column(ink)
    if paper:
        before = result.copy()
        flat_under_print(source, result, flat, colours)
        result[~valid] = before[~valid]
        paper = np.any(result != before)
    return preserve_pen_beside_column(source, tone, model, mask, result, ink, valid) or readings or paper


def restore_typeset_stock(source, mask, prediction):
    rows, cols = np.where(mask)
    if not len(cols):
        return False
    box = np.s_[max(0, rows.min()-53):rows.max()+54, max(0, cols.min()-53):cols.max()+54]
    source, mask, prediction = source[box], mask[box], prediction[box]
    if mask.size > 750_000:
        return False
    pause = restore_registered_pause_marks(source, mask, prediction)
    ink, flat, colours = printed_components(source, mask, prediction)
    if not ink.any():
        return pause
    before = prediction.copy()
    if (ink & ~flat).any():
        distance = distance_transform_edt(~ink)
        drawing = (source.mean(2) < 193) & ~ink
        clearance = distance_transform_edt(~drawing) if drawing.any() else np.full_like(distance, np.inf)
        isolated = not flat.any() and wholly_surrounded_wash(source, mask, ink, distance)
        wash_under_print(source, prediction, distance, clearance, isolated)
    if flat.any():
        flat_under_print(source, prediction, flat, colours)
    return pause or bool(np.any(before != prediction))
