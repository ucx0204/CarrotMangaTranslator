"""Read the visible illustration through the white glow of a layered title."""
import numpy as np
from scipy.ndimage import distance_transform_edt, find_objects, gaussian_filter, gaussian_filter1d, label
from scipy.spatial import cKDTree


def exposed_illustration_banks(gray, clean, ink, distance, opaque):
    """Find two-dimensional ink adjoining shading inside the print. A panel
    rule, crease or the edge of an independent solid badge is insufficient."""
    safe = (distance > 14) & opaque
    low = gaussian_filter(gray.astype('f'), 1)
    gy, gx = np.gradient(low)
    power = gaussian_filter(safe.astype('f'), 17)

    def fraction(feature):
        return gaussian_filter((safe & feature).astype('f'), 17) / np.maximum(.03, power)

    rich = safe & (power > .29) & (fraction(low < 148) > .14) & (fraction(low > 207) > .17)
    rich &= fraction(np.hypot(gy, gx) > 14) > .10
    parts, _ = label(rich, np.ones((3, 3)))
    rich &= np.bincount(parts.ravel())[parts] > 570
    energy = gaussian_filter(safe.astype('f'), 10)
    xx, yy, xy = (gaussian_filter(np.where(safe, field, 0), 10) / np.maximum(.04, energy)
                  for field in (gx*gx, gy*gy, gy*gx))
    rich &= (xx + yy - np.hypot(xx - yy, 2*xy)) / 2 > 60
    shaded = gaussian_filter(clean.astype('f'), 3) < 183
    dark_mass = gaussian_filter((shaded & (distance_transform_edt(ink) > 6)).astype('f'), 17)
    if not (dark_mass > .17).any():
        return
    to_shading = distance_transform_edt(dark_mass <= .17)
    parts, _ = label(rich, np.ones((3, 3)))
    retained = np.zeros_like(ink)
    for i, bounds in enumerate(find_objects(parts), 1):
        part = parts[bounds] == i
        if part.sum() >= 200 and to_shading[bounds][part].min() < 90:
            retained[bounds] |= part
    if retained.any():
        return distance_transform_edt(~retained), distance_transform_edt(~(ink & shaded))


def restore_washed_title(source, ink, decoded, prior, register, choose_boundary):
    """Use the clean substrate for uninterrupted paper and sparse contour
    lines. At dense illustrated banks, register the original-reference edit
    and join it at a single low-disagreement seam between pen strokes."""
    opaque = source[:, :, 3] == 255
    ink = ink & opaque
    result = source.copy()
    if not ink.any():
        return result
    result[ink, :3] = prior[ink]
    distance = distance_transform_edt(~ink)
    banks = exposed_illustration_banks(source[:, :, 1], prior[:, :, 1], ink, distance, opaque)
    if banks is None:
        return result
    to_drawing, to_shading = banks
    required = opaque & (distance < 34) & (to_drawing < 121) & (to_shading < 73)
    if not required.any():
        return result
    allowed = opaque & (distance < 70) & (to_drawing < 174) & (to_shading < 109)
    aligned = register(source[:, :, :3], decoded, opaque & (distance > 8))
    aligned = np.rint(np.clip(aligned, 0, 255)).astype('u1')
    choice = choose_boundary(result[:, :, :3], aligned, required, allowed)
    result[choice, :3] = aligned[choice]
    return result


def original_layered_ink(rgb, selected):
    y,x=np.where(selected)
    if len(y)<14000 or np.ptp(x)<450 or np.ptp(y)<170 or rgb.shape[0]*rgb.shape[1]>1600000:
        return
    c=rgb.astype('f')
    hi=c.max(2);lo=c.min(2);span=hi-lo
    red,green,blue=c.transpose(2,0,1)
    delta=np.maximum(1,span)
    hue=np.rint(4*np.where(hi==red,(green-blue)/delta,
                           np.where(hi==green,2+(blue-red)/delta,4+(red-green)/delta))).astype(int)%24
    white=(lo>229)&(span<34)
    to_white=distance_transform_edt(~white)
    dark=(hi<162)&(span>19)
    votes=dark&selected&(to_white<4.8)
    hist=np.bincount(hue[votes],minlength=24)
    totals=hist+np.roll(hist,1)+np.roll(hist,-1)
    peak=totals.argmax()
    if hist.sum()<450 or totals[peak]<.52*hist.sum():
        return
    family=(np.minimum((hue-peak)%24,(peak-hue)%24)<=2)&dark
    pieces,count=label(family,np.ones((3,3)))
    sizes=np.bincount(pieces.ravel(),minlength=count+1)
    near=np.bincount(pieces[to_white<=5],minlength=count+1)
    soft=np.bincount(pieces[to_white<=15],minlength=count+1)
    owned=np.bincount(pieces[selected],minlength=count+1)
    keep=(sizes>=5)&(near>.30*sizes)&(soft>.80*sizes)&(owned>.62*sizes)
    keep[0]=False
    core=keep[pieces]
    if core.sum()<1800:
        return
    distance=distance_transform_edt(~core)
    # Coloured terminals can turn gold or pink as they leave the navy stroke.
    # They form thin connected ink bordered on both sides by luminous paper.
    flourishes=selected&(span>30)&(to_white<7)&(distance<38)
    parts,n=label(flourishes,np.ones((3,3)))
    touch=np.bincount(parts[core|(distance<2)],minlength=n+1)
    close=np.bincount(parts[distance<12],minlength=n+1)
    sizes=np.bincount(parts.ravel(),minlength=n+1)
    attached=(touch>=2)|((close>.23*sizes)&(sizes>15))
    attached[0]=False
    return core|attached[parts]


def recover_underprint(rgb, selected):
    core=original_layered_ink(rgb,selected)
    if core is None:
        return
    transmit=255-rgb.astype('f')
    magnitude=np.linalg.norm(transmit,axis=2)
    direction=transmit/np.maximum(1,magnitude[:,:,None])
    distance=distance_transform_edt(~core)
    allow=distance_transform_edt(~selected)<12
    # Untinted banks supply the brightness of the same material. Its actual
    # hue and fine line structure survive translucent white overprinting.
    bank=(distance>40)&(distance<110)&(magnitude>40)
    by,bx=np.where(bank)
    if len(by)<1000:
        return
    by,bx=by[::3],bx[::3]
    def feature(y,x):
        return np.column_stack([y/46,x/46,16*direction[y,x]])
    tree=cKDTree(feature(by,bx))
    y,x=np.where((distance<=44)&allow&~core)
    if not len(y):
        return
    weights=[]; estimates=[]
    for start in range(0,len(y),16000):
        ys,xs=y[start:start+16000],x[start:start+16000]
        cost,ids=tree.query(feature(ys,xs),k=24,eps=.12)
        tone=magnitude[by[ids],bx[ids]]
        estimates.append(np.median(tone,axis=1))
        weights.append(np.clip((4.5-np.median(cost,axis=1))/2.9,0,1))
    base=np.concatenate(estimates)
    trust=np.concatenate(weights)
    current=magnitude[y,x]
    corrected=rgb.copy()
    blend=trust*np.clip((44-distance[y,x])/12,0,1)
    strength=current+blend*np.maximum(0,base-current)
    recovered=255-direction[y,x]*strength[:,None]
    corrected[y,x]=np.rint(recovered).clip(0,255).astype('u1')
    holes=distance<3.8
    holes[y,x]|=(distance[y,x]<25)&((current<32)|((current<.29*base)&(trust<.55)))
    holes&=allow
    return corrected,holes,core


def display_view(core):
    """Keep the small reading and both main rows inside the same reference."""
    height, width = core.shape
    ys, xs = np.where(core)
    column_span = np.ptp(xs)+1
    projection = gaussian_filter1d(core.sum(1).astype('f'), 3.)
    strong = np.flatnonzero(projection > .083*column_span)
    runs = [v for v in np.split(strong, np.flatnonzero(np.diff(strong)>15)+1)
            if len(v) >= 13 and np.count_nonzero(core[v].any(0)) > .34*column_span]
    if len(runs) < 3:
        return
    previous, lower = runs[-2:]
    if len(previous) < 33 or len(lower) < 33 or lower[0]-previous[-1] > .21*column_span:
        return
    pad = min(220, max(64, round(.66*column_span)))
    x0, x1 = max(0, int(xs.min())-pad), min(width, int(xs.max())+pad+1)
    # The exposed strip above the little reading is enough to anchor its ink.
    top = max(0, min(int(ys.min())-max(18, round(.025*column_span)), int(previous[-1])+12-pad))
    bottom = min(height, int(ys.max())+pad+1)
    return int(x0), int(top), int(x1-x0), int(bottom-top)


def prepare_display_reference(cv, rgb, selected):
    measured = recover_underprint(rgb, selected)
    if measured is None:
        return
    clean, holes, core = measured
    view = display_view(core)
    if view is None:
        return
    distance = distance_transform_edt(~core)
    cover = (distance_transform_edt(~selected) <= 23) & (distance < 39)
    height, width = cover.shape
    small = cv.resize(rgb, (width//6, height//6), interpolation=cv.INTER_AREA)
    missing = cv.resize(cover.astype('f'), small.shape[1::-1], interpolation=cv.INTER_AREA) > .008
    coarse = cv.inpaint(small, missing.astype('u1'), 4, cv.INPAINT_NS)
    guess = cv.resize(coarse, (width, height), interpolation=cv.INTER_CUBIC)
    guess[~cover] = rgb[~cover]
    error = np.linalg.norm(clean.astype('f')-guess, axis=2)
    quality = np.clip((78-error)/42, 0, 1)*np.clip((distance-7)/6, 0, 1)*(~holes)
    weight = (gaussian_filter(quality, 1.1)*np.clip((distance-6)/5, 0, 1)*(~holes))[:, :, None]
    prior = np.rint(guess*(1-weight)+clean*weight).astype('u1')
    prior[~cover] = rgb[~cover]
    return prior, view


if __name__ == "__main__":
    import json
    import sys
    from PIL import Image
    tools, source, stencil, output = sys.argv[1:]
    sys.path.insert(0, tools)
    import cv2
    with Image.open(source) as original, Image.open(stencil) as mask:
        candidate = prepare_display_reference(cv2, np.asarray(original.convert('RGB')), np.asarray(mask.convert('L')) > 127)
    if candidate is None:
        print("unchanged")
    else:
        prior, (x, y, w, h) = candidate
        Image.fromarray(prior[y:y+h, x:x+w]).save(output)
        print(json.dumps(dict(x=x, y=y, w=w, h=h)))
