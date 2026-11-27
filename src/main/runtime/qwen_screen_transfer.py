"""Sample a printed screen at its original phase across outlined sound lettering."""
import numpy as np
from pathlib import Path
from runpy import run_path
from scipy.ndimage import distance_transform_edt, gaussian_filter, uniform_filter1d
from scipy.signal import find_peaks


def shift(array, dx):
    moved = np.zeros_like(array)
    if dx > 0:
        moved[:, :-dx] = array[:, dx:]
    else:
        moved[:, -dx:] = array[:, :dx]
    return moved


def native_repeats(detail, train):
    scores = np.zeros(91)
    for dx in range(2, min(len(scores), detail.shape[1]-1)):
        known = train & shift(train, dx)
        if known.sum() < 140:
            continue
        left, right = detail[known], shift(detail, dx)[known]
        scores[dx] = (left*right).sum()/np.sqrt(max(1, (left*left).sum()*(right*right).sum()))
    peaks = find_peaks(scores)[0]
    peaks = peaks[(peaks >= 6) & (scores[peaks] > max(.46, .69*scores.max()))]
    if len(peaks) >= 5 and np.median(np.diff(peaks)) <= 12:
        return [(sign*int(p), scores[p]) for p in peaks for sign in (-1, 1)]


def row_samples(gray, known, shifts):
    costs, values = [], []
    for dx, certainty in shifts:
        donor, available = shift(gray, dx), shift(known, dx)
        both = known & available
        evidence = both*np.minimum(abs(gray-donor), 66)
        fine, coarse = (gaussian_filter(both.astype('f'), scale) for scale in ((3.4,10), (8,26)))
        local = gaussian_filter(evidence, (3.4,10))/np.maximum(.0001, fine)
        broad = gaussian_filter(evidence, (8,26))/np.maximum(.0001, coarse)
        fraction = np.clip(fine/.24, 0, 1)
        error = local*fraction+broad*(1-fraction)+.08*abs(dx)+22*(1-certainty)
        costs.append(np.where(available & (coarse>.045), error, 10000))
        values.append(donor)
    costs, values = np.asarray(costs), np.asarray(values)
    best = costs.min(0)
    weight = np.exp(np.maximum(-(costs-best)/6, -90))*(costs<150)
    order = values.argsort(axis=0)
    values = np.take_along_axis(values, order, axis=0)
    cumulative = np.take_along_axis(weight, order, axis=0).cumsum(0)
    index = np.argmax(cumulative >= .5*cumulative[-1], axis=0)
    return np.take_along_axis(values, index[None], axis=0)[0], best


def registered_screen(gray, selected, opaque):
    yy, xx = np.indices(gray.shape)
    y, x = np.where(selected)
    distance = distance_transform_edt(~selected)
    bank = ((yy >= y.min()-17) & (yy <= y.max()+17) & (xx >= x.min()-95)
            & (xx <= x.max()+95) & (distance>12) & opaque)
    low = gaussian_filter(gray, 2.1)
    detail = gray-low
    stock = bank & (gaussian_filter(detail**2, 2.2)>21**2) & (low>32) & (low<239)
    held = ((xx//6 + yy//5) % 7 == 0)
    shifts = native_repeats(detail, stock & ~held)
    if shifts is None:
        return
    estimate, cost = row_samples(gray, bank & ~held, shifts)
    test = held & stock & (distance<43) & (cost<75)
    if test.sum()<130:
        return
    residual = abs(estimate[test]-gray[test])
    if np.median(residual)>15 or residual.mean()>.53*np.mean(abs(detail[test])):
        return
    estimate, cost = row_samples(gray, bank, shifts)
    if (cost[selected] < 75).mean()<.975:
        return
    keep = np.clip((31-gaussian_filter(abs(gray-estimate), 1.05))/13, 0, 1)*np.clip((distance-1.9)/2.3, 0, 1)
    feather = np.clip((17-distance)/2, 0, 1)
    mixed = gray+(1-keep)*feather*(estimate-gray)
    return mixed, (distance<17) & opaque & (cost<75), distance


def outside_rule(gray, selected, distance):
    """Read the line and its white gutter where they emerge on both sides of the print."""
    height, width = gray.shape
    sy, sx = np.where(selected)
    y, x = np.indices(gray.shape)
    band = (abs(y-sy.max()) < 18) & (distance>12)
    band &= (y>4) & (y<height-7) & (x>sx.min()-78) & (x<sx.max()+78)
    along = uniform_filter1d(gray,7,axis=1)
    gutter = np.minimum.reduce([np.roll(along,-offset,0) for offset in (3,4,5)])
    local_min = (gray<=np.roll(gray,1,0)) & (gray<np.roll(gray,-1,0))
    ys,xs = np.where(band & local_min & (gray<124) & (along<143) & (gutter>242))
    if len(xs)<58:
        return
    best = None
    for slope in np.arange(-.22,.221,.02):
        intercept = np.rint(ys-slope*(xs-width/2)).astype(int)
        bins = np.bincount(intercept-intercept.min())
        support = bins.argmax()+intercept.min()
        use = abs(intercept-support)<=2
        count = len(np.unique(xs[use]))
        if best is None or count>best[0]:
            best = count,use
    use = best[1]
    for limit in (2.8,1.9,1.2):
        if len(np.unique(xs[use]))<55:
            return
        rows, cols = ys[use], xs[use]
        offsets = np.arange(-2,3)[:,None]
        density = np.maximum(0, 190-gray[rows+offsets,cols])
        centers = rows+(offsets*density).sum(0)/np.maximum(1,density.sum(0))
        curve = np.polynomial.Polynomial.fit(cols,centers,2)
        use = abs(ys-curve(xs))<limit
    if abs(curve.deriv(2)(width/2))>.0025:
        return
    left = use & (xs<sx.min())
    right = use & (xs>sx.max())
    if min(len(np.unique(xs[left])),len(np.unique(xs[right])))<20:
        return
    cols = np.unique(xs[use])
    centers = curve(cols)
    rows = np.rint(centers).astype(int)[None]+np.arange(-7,9)[:,None]
    if rows.min()<0 or rows.max()>=height:
        return
    phase = rows-centers[None]
    bins = np.arange(-6.5,7.51,.125)
    profile = []
    for shift_by in bins:
        witness = abs(phase-shift_by)<.18
        if witness.sum()<5:
            return
        profile.append(np.median(gray[rows,cols][witness]))
    profile = np.asarray(profile)
    if profile.min()>82 or profile[(bins>3)&(bins<5)].mean()<238:
        return
    delta = y-curve(x)
    if np.sum((abs(delta)<.7) & (distance<13))<5:
        return
    strip = (delta >= -5.5) & (delta <= 6.5) & (x>=cols.min()) & (x<=cols.max())
    return strip,np.interp(delta,bins,profile)


def restore_printed_screen_rows(source, mask, result, opaque=None):
    y, x = np.where(mask)
    if not 180<=len(y)<=8000 or not 28<=np.ptp(y)<=200 or not 8<=np.ptp(x)<=145:
        return False
    box = np.s_[max(0,y.min()-37):y.max()+38, max(0,x.min()-100):x.max()+101]
    rgb, selected, out = source[box][:,:,:3], mask[box], result[box][:,:,:3]
    if np.mean(np.ptp(rgb, axis=2)>5)>.014:
        return False
    valid = np.ones_like(selected) if opaque is None else opaque[box]
    gray = rgb[:,:,1].astype('f')
    white_rim = (distance_transform_edt(~selected)<5) & ~selected
    if (not white_rim.any() or (gray[white_rim]>235).mean()<.78
            or (gray[selected]<100).mean()<.20 or not valid[selected].all()):
        return False
    paper = registered_screen(gray, selected, valid)
    if paper is None:
        return False
    reconstructed, write, distance = paper
    for rows, mark, clear, field in ((gray,selected,distance,reconstructed),
                                     (gray[::-1],selected[::-1],distance[::-1],reconstructed[::-1])):
        edge = outside_rule(rows, mark, clear)
        if edge is not None:
            strip, profile = edge
            stripe = strip & (clear<17)
            intact = (clear>1) & (abs(rows-profile)<17)
            field[stripe] = np.where(intact,rows,profile)[stripe]
    out[write] = np.rint(reconstructed[write,None]).clip(0,255).astype('u1')
    return True


def graded_density(low, bank, held, x, y):
    """Fit the slow change in ink coverage independently of its dot phase."""
    xx, yy = 2*x / low.shape[1]-1, 2*y / low.shape[0]-1
    design = np.stack([np.ones_like(xx), xx, yy, xx**2, yy**2, xx*yy,
                       yy**3, xx**3, xx*yy**2, yy*xx**2], axis=-1)
    original = bank & ~held
    train = original.copy()
    for _ in range(4):
        coefficients = np.linalg.lstsq(design[train][::4], low[train][::4], rcond=None)[0]
        level = design @ coefficients
        error = abs(low-level)
        train = original & (error < max(4., np.percentile(error[original], 86)))
    # Reject material boundaries and illustrations that a smooth density cannot describe.
    if error[held & bank].mean() > 5.5 or np.mean(error[bank] < 9) < .83:
        return
    return level, bank & (error < 9)


def graded_phase(gray, trend, valid, held, axes, x, y):
    first, second = axes
    harmonics = [i*first+j*second for i in range(4) for j in range(-3, 4)
                 if (i or j > 0) and i*i+j*j <= 10]
    angles = [2*np.pi*(x*u+y*v) for u, v in harmonics]
    basis = np.stack([np.ones_like(x)] +
                     [fn(angle) for angle in angles for fn in (np.cos, np.sin)], axis=-1).astype("f")
    prediction = np.zeros_like(gray)
    mass = np.zeros_like(gray)
    residual = gray-trend
    identity = np.eye(basis.shape[-1]) * .01
    for cy in range(0, gray.shape[0]+12, 12):
        for cx in range(0, gray.shape[1]+12, 12):
            sample = np.s_[max(0,cy-65):cy+66, max(0,cx-65):cx+66]
            train = valid[sample] & ~held[sample]
            if train.sum() < 90:
                continue
            matrix = basis[sample][train][::2]
            squared = (y[sample][train][::2]-cy)**2 + (x[sample][train][::2]-cx)**2
            weights = np.exp(-squared / (2*24**2))
            weighted = matrix.T * weights
            coef = np.linalg.solve(weighted @ matrix + identity,
                                   weighted @ residual[sample][train][::2])
            tile = np.s_[max(0,cy-12):cy+13, max(0,cx-12):cx+13]
            blend = (1-abs(y[tile]-cy)/13) * (1-abs(x[tile]-cx)/13)
            prediction[tile] += blend*(basis[tile] @ coef+trend[tile])
            mass[tile] += blend
    return prediction/np.maximum(.00001, mass), mass


def verified_graded_field(gray, selected, clear):
    low = gaussian_filter(gray, 2.2)
    detail = gray-low
    amplitude = np.sqrt(gaussian_filter(detail**2, 3))
    roughness = np.sqrt(gaussian_filter((low-gaussian_filter(low,4))**2, 5))
    bank = (clear>9) & (low>35) & (low<240) & (roughness<4.5) & (amplitude>18)
    if bank.sum() < 2000 or np.mean(bank[clear>9]) < .53:
        return
    if np.ptp(np.percentile(low[bank], [15,85])) < 18:
        return
    y, x = np.indices(gray.shape)
    held = (x//10 + 3*(y//12)) % 7 == 0
    if (bank & held).sum() < 240:
        return
    density = graded_density(low, bank, held, x, y)
    if density is None:
        return
    trend, valid = density
    # Withhold complete tiles from the phase search as well as the local fit.
    sy, sx = np.where(valid & ~held)
    stride = max(1, len(sx)//14000)
    sy, sx = sy[::stride], sx[::stride]
    frequencies = run_path(str(Path(__file__).with_name("qwen-screen-detail.py")))["screen_frequencies"]
    modes = frequencies(np.column_stack([sx,sy]), detail[sy,sx]/amplitude[sy,sx], gray.shape)
    if len(modes) < 2:
        return
    a = modes[0]
    b = next((v for v in modes[1:] if abs(a[0]*v[1]-a[1]*v[0])>.03), None)
    if b is None:
        return
    prediction, mass = graded_phase(gray, trend, valid, held, (a,b), x, y)
    test = valid & held
    if np.min(mass[selected]) <= 0 or test.sum() < 240:
        return
    error = abs(gray[test]-prediction[test])
    agreement = np.corrcoef((gray-trend)[test], (prediction-trend)[test])[0,1]
    if not (agreement > .94 and np.percentile(error,95) < 32 and error.mean() < 13):
        return
    return prediction, trend


def joined_pen_ridges(observed):
    """Continue a narrow ridge only where two collinear original strokes support it."""
    from scipy.ndimage import grey_opening, grey_closing, shift as move
    bridge = np.zeros_like(observed)
    for angle in np.arange(0, np.pi, np.pi/48):
        def footprint(radius):
            steps = np.arange(-radius, radius+1)
            dx = np.rint(steps*np.cos(angle)).astype(int)
            dy = np.rint(steps*np.sin(angle)).astype(int)
            rx, ry = max(abs(dx)), max(abs(dy))
            support = np.zeros((2*ry+1, 2*rx+1), bool)
            support[dy+ry, dx+rx] = True
            return support
        normal = (round(4*np.cos(angle)), -round(4*np.sin(angle)))
        def ridge(field, fraction):
            left = move(field, normal, order=0, mode="nearest")
            right = move(field, (-normal[0], -normal[1]), order=0, mode="nearest")
            return np.maximum(0, field-fraction*np.maximum(left,right))
        # A point or a broad shadow is insufficient evidence for another line.
        endpoints = ridge(grey_opening(observed, footprint=footprint(4)), .72)
        joined = grey_closing(endpoints, footprint=footprint(27))
        bridge = np.maximum(bridge, ridge(joined,.75))
    return np.clip((bridge-12)*1.1,0,200)


def restore_graded_print(source, mask, guide):
    from scipy.ndimage import binary_propagation, grey_closing
    sy, sx = np.where(mask)
    if not 6000 <= len(sx) <= 95000:
        return
    area = np.s_[max(0,sy.min()-48):sy.max()+49, max(0,sx.min()-48):sx.max()+49]
    selected = mask[area]
    if selected.size > 400000:
        return
    rgb = source[area]
    if not (rgb[:,:,0] == rgb[:,:,1]).all() or not (rgb[:,:,2] == rgb[:,:,1]).all():
        return
    gray = rgb[:,:,1].astype("f")
    clear = distance_transform_edt(~selected)
    field = verified_graded_field(gray, selected, clear)
    if field is None:
        return
    prediction, trend = field
    # The detector can join the two columns of type along a real eyelash.
    # Preserve connected native pen. White keylines block ink propagation.
    white = (gray>212) & (gray-prediction>38) & (clear<11)
    if white.sum() < .045*selected.sum():
        return
    keyline = distance_transform_edt(~white)
    smooth = gaussian_filter(guide[area][:,:,1].astype("f"), .85)
    yy, xx = np.ogrid[-8:9,-8:9]
    depth = grey_closing(smooth, footprint=xx*xx+yy*yy<=64)-smooth
    native_depth = trend-gaussian_filter(gray,1.15)
    anchor = (gaussian_filter((native_depth>25).astype("f"),1.2)>.45) & (clear>6) & (keyline>3.8)
    pen = np.maximum(depth-3,0)*np.clip((44-distance_transform_edt(~anchor))/31,0,1)
    reach = binary_propagation(anchor, mask=(native_depth>7)&(keyline>3), structure=np.ones((3,3)))
    protect = np.clip((5-distance_transform_edt(~reach))/3,0,1)*np.clip((keyline-2)/2,0,1)
    observed = np.maximum(0, native_depth)*np.clip((clear-3)/2,0,1)
    observed = np.maximum(observed, np.maximum(0,native_depth)*protect)*np.clip((keyline-2)/2,0,1)
    pen = np.maximum(pen, joined_pen_ridges(observed))
    tone = np.clip(prediction/np.maximum(20,trend)*(trend-pen*1.35),0,255)
    keep = (gray<prediction+8) & (gaussian_filter(gray-prediction,1)<8)
    tone[keep] += (gray[keep]-tone[keep])*protect[keep]
    result = source.copy()
    paint = clear<=8
    result[area][paint] = np.rint(np.clip(tone[paint],0,255)).astype("u1")[:,None]
    return result


if __name__ == "__main__":
    import sys
    from PIL import Image
    input_path, mask_path, guide_path, destination, *mode = sys.argv[1:]
    with Image.open(input_path) as image:
        rgba = np.array(image.convert("RGBA"))
    with Image.open(mask_path) as image:
        mask = np.array(image.convert("L"))>127
    result = None
    if (rgba[:, :, 3] == 255).all():
        if mode == ["display-hatching"]:
            restore = run_path(str(Path(__file__).with_name("qwen_hatching.py")))["restore_display_hatching"]
            result = restore(rgba[:, :, :3], mask)
        elif not mode:
            with Image.open(guide_path) as image:
                guide = np.array(image.convert("RGB"))
            result = restore_graded_print(rgba[:, :, :3], mask, guide)
    if result is None:
        print("unchanged")
    else:
        Image.fromarray(result).save(destination)
        print("applied")
