"""Read pale printed type on a translucent horizontal tint from its exposed banks."""
import numpy as np
from scipy.ndimage import distance_transform_edt, gaussian_filter1d, grey_opening, label, percentile_filter


def tint_edges(rgb):
    """A translucent overlay changes hue in opposite directions at its two edges."""
    delta = rgb[3:] - rgb[:-3]
    vectors = np.median(delta, axis=1)
    chroma = vectors - vectors.mean(1, keepdims=True)
    strength = np.linalg.norm(chroma, axis=1)
    gap = np.arange(len(vectors))[None, :] - np.arange(len(vectors))[:, None]
    score = (-chroma @ chroma.T) / (1 + .015*abs(strength[:, None]-strength[None]))
    score[(gap < 18) | (gap > 128)] = -1
    top, bottom = np.unravel_index(score.argmax(), score.shape)
    if min(strength[top], strength[bottom]) < 39 or score[top, bottom] < 1350:
        return
    if chroma[top] @ chroma[bottom] > -.88*strength[top]*strength[bottom]:
        return
    # A coloured contour inside a drawing need not span the whole selection.
    for row in (top, bottom):
        along = delta[row] @ chroma[row] / strength[row]
        if np.mean(along > 20) < .67 or sum(np.median(a)>19 for a in np.array_split(along, 6)) < 5:
            return
    return top+2, bottom+2


def white_faces(rgb, selected):
    high, low = rgb.max(2), rgb.min(2)
    edge = np.concatenate((rgb[3:7], rgb[-7:-3]))
    ceiling = percentile_filter(np.percentile(edge, 86, axis=0), 75, size=(17, 1))
    strong = (low > 204) & (high-low < 58)
    weak = (low > 150) & (high-low < 98) & ((rgb-ceiling[None]).min(2)>7)
    strong[:4] = strong[-3:] = False
    observed = strong & selected
    if observed.sum() < 80 or strong.sum() > 3*observed.sum():
        return
    parts, count = label(strong | weak, np.ones((3, 3)))
    votes = np.bincount(parts[observed], minlength=count+1)
    keep = (votes >= 4) & (np.bincount(parts.ravel(), minlength=count+1)<.12*rgb.shape[0]*rgb.shape[1])
    keep[0] = False
    if keep.sum()<4:
        return
    faces = keep[parts]
    coverage = np.flatnonzero(faces.any(0))
    if len(coverage)<19 or np.ptp(coverage)<3*len(rgb) or faces.mean()>.38:
        return
    if np.median((high-low)[~faces])<43:
        return
    return distance_transform_edt(~faces)<=4.75


def native_donor(rgb, safe, y, x, dy, dx):
    h,w = safe.shape
    depth = np.zeros(len(x), np.float32)
    values = np.zeros((len(x),3), np.float32)
    gradients = values.copy()
    for step in range(1,39):
        pending = np.flatnonzero(depth == 0)
        if not len(pending):
            break
        row = np.rint(y[pending]+step*dy).astype(int).clip(0,h-1)
        col = np.rint(x[pending]+step*dx).astype(int).clip(0,w-1)
        hit = safe[row,col]
        indices = pending[hit]
        if not len(indices):
            continue
        depth[indices] = step
        values[indices] = rgb[row[hit],col[hit]]
        row = np.rint(y[indices]+(step+3)*dy).astype(int).clip(0,h-1)
        col = np.rint(x[indices]+(step+3)*dx).astype(int).clip(0,w-1)
        gradients[indices] = rgb[row,col]-values[indices]
    return depth,values,gradients


def continue_surface(rgb,mask,decoded):
    y,x = np.where(mask)
    if len(x)>85000:
        return
    safe=~mask
    best=np.full(len(x),10000.,np.float32)
    total=np.zeros(len(x),np.float32)
    combined=np.zeros((len(x),3),np.float32)
    for angle in np.arange(32)*np.pi/32:
        dy,dx=np.sin(angle),np.cos(angle)
        a,va,ga=native_donor(rgb,safe,y,x,dy,dx)
        b,vb,gb=native_donor(rgb,safe,y,x,-dy,-dx)
        span=a+b
        valid=(a>0)&(b>0)
        cost=np.linalg.norm(va-vb,axis=1)+.46*(np.linalg.norm(ga,axis=1)+np.linalg.norm(gb,axis=1))+.58*span
        score=np.where(valid,cost,10000)
        new=np.minimum(best,score)
        old_weight=np.exp(-np.minimum((best-new)/3,60))
        weight=valid*np.exp(-np.minimum((score-new)/3,60))
        value=(b[:,None]*va+a[:,None]*vb)/np.maximum(.01,span[:,None])
        combined=combined*old_weight[:,None]+weight[:,None]*value
        total=total*old_weight+weight
        best=new
    out=rgb.copy()
    out[y,x]=np.where((total>0)[:,None],combined/np.maximum(.001,total[:,None]),decoded[y,x])
    return out


def ridge_seeds(valid):
    y,x=np.where(valid)
    if len(x)<80:
        return []
    seeds=[]
    for center in range(42, valid.shape[1], 50):
        local=abs(x-center)<53
        if local.sum()<32:
            continue
        sy,sx=y[local],x[local]-center
        for slope in (-1.2,-.85,-.65,-.48,-.33,-.2,.2,.33,.48,.65,.85,1.2):
            b=np.rint(sy-slope*sx).astype(int)
            bins=np.bincount(b-b.min())
            intercept=b.min()+bins.argmax()
            hit=abs(b-intercept)<=1
            if len(np.unique(sx[hit]))>=24:
                seeds.append((bins.max(),center,slope,intercept))
    return sorted(seeds,reverse=True)[:28]


def fit_ridge(high,good,xs,yy,seed):
    _,center,slope,b=seed
    line=b+slope*(xs-center)
    for reach in (130,180,240):
        visible=good&(abs(yy-line)<3.6)&(abs(xs-center)<reach)
        cols=np.flatnonzero(visible.any(0))
        if len(cols)<26:
            return
        wt=visible[:,cols]*np.maximum(0,high[:,cols]-12)
        ys=(yy[:,cols]*wt).sum(0)/np.maximum(.001,wt.sum(0))
        fit=np.polynomial.Polynomial.fit(cols,ys,2,w=np.sqrt(np.minimum(80,wt.sum(0))))
        if abs(fit.deriv(2)(center))>.012:
            return
        line=fit(xs)
    visible=good&(abs(yy-line)<3.3)&(abs(xs-center)<240)
    cols=np.flatnonzero(visible.any(0))
    if len(cols)>max(52,min(112,.18*len(xs))) and len(cols)>.59*(np.ptp(cols)+1):
        return len(cols),line,visible


def register_ridge(rgb,mask,out):
    h,w=mask.shape
    yy,xx=np.indices(mask.shape);xs=np.arange(w)
    y,x=np.ogrid[-8:9,-8:9]
    base=grey_opening(out.mean(2),footprint=(x*x+y*y<=8.5**2))
    high=rgb.mean(2)-base
    good=(high>19)&~mask
    fits=[fit for seed in ridge_seeds(good) if (fit:=fit_ridge(high,good,xs,yy,seed)) is not None]
    if not fits:
        return
    _,line,visible=max(fits,key=lambda v:v[0])
    columns=visible.any(0)
    left=np.maximum.accumulate(np.where(columns,xs,-1000))
    right=np.minimum.accumulate(np.where(columns,xs,1000)[::-1])[::-1]
    delta=yy-line
    region=(abs(delta)<6)&mask&(xs-left<36)&(right-xs<36)
    profiles=[]
    for shift in range(-7,8):
        y=np.rint(line+shift).astype(int).clip(0,h-1)
        bank=(~mask[y,xs])&columns&(line>8)&(line<h-9)
        mass=gaussian_filter1d(bank.astype(np.float32),9)
        cols=np.flatnonzero(mass>.16)
        if len(cols)<2:
            return
        local=gaussian_filter1d(np.where(bank[:,None],rgb[y,xs],0),9,axis=0)/np.maximum(.00001,mass[:,None])
        profiles.append(np.stack([np.interp(xs,cols,local[cols,c]) for c in range(3)],1))
    prof=np.stack(profiles)
    region &= (prof[7]-(prof[0]+prof[-1])/2).mean(1)>17
    idx=np.clip(delta+7,0,13.99);i=idx.astype(int);fraction=(idx-i)[:,:,None]
    target=prof[i,xx]*(1-fraction)+prof[i+1,xx]*fraction
    weight=(np.clip((6-abs(delta))/3,0,1)*region)[:,:,None]
    out[:]=out*(1-weight)+target*weight


def restore_transparent_caption(source,mask,result,opaque=None):
    y,x=np.where(mask)
    if len(x)<180 or np.ptp(x)<140 or np.ptp(x)<3.7*np.ptp(y) or np.ptp(y)>170:
        return False
    left=max(0,x.min()-11);right=min(source.shape[1],x.max()+12)
    first=max(0,y.min()-40);last=min(source.shape[0],y.max()+41)
    if (right-left)*(last-first)>550000:
        return False
    rgb=source[first:last,left:right,:3].astype(np.float32)
    band=tint_edges(rgb)
    if band is None:
        return False
    top,bottom=band
    window=np.s_[first+top:first+bottom,left:right]
    if mask[window].sum()<.42*len(x):
        return False
    local=rgb[top:bottom]
    holes=white_faces(local,mask[window])
    if holes is None:
        return False
    repaired=continue_surface(local,holes,result[window])
    if repaired is None:
        return False
    register_ridge(local,holes,repaired)
    # The enclosing box can be substantially larger than the printed letter.
    # Recover the original drawing between letters, including the tint edges.
    parts,count=label(mask, np.ones((3,3)))
    intersects=np.bincount(parts[window].ravel(), minlength=count+1)>0
    intersects[0]=False
    selected=intersects[parts]
    write=distance_transform_edt(~selected)<=14
    other=mask & ~selected
    if other.any():
        write &= distance_transform_edt(~other)>14
    write[:max(0,first+top-28)]=False
    write[min(len(mask),first+bottom+28):]=False
    if opaque is not None:
        write &= opaque
    result[write]=source[write,:3]
    active=write[window]&holes
    result[window][active]=np.rint(repaired[active]).clip(0,255).astype(np.uint8)
    return True
