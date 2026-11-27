"""Locate the actual four printed edges around an oblique inset illustration."""
import numpy as np
from pathlib import Path
from PIL import Image


def line_candidates(cv, rgb, center):
    lab = cv.cvtColor(rgb, cv.COLOR_RGB2LAB)
    detector = cv.createLineSegmentDetector()
    proposals = []
    for channel in cv.split(lab):
        lines = detector.detect(channel)[0]
        if lines is None:
            continue
        for a,b in lines.reshape(-1,2,2):
            v = b-a
            length = np.linalg.norm(v)
            if length < max(19,.055*min(rgb.shape[:2])):
                continue
            angle = (np.degrees(np.arctan2(v[1],v[0]))+45)%180-45
            horizontal = angle < 45
            tilt = angle if horizontal else angle-90
            if not 5.5<abs(tilt)<34:
                continue
            v = v/length
            if v[0 if horizontal else 1]<0:
                v=-v
            normal=np.array([-v[1],v[0]])
            offset=normal@(a-center)
            proposals.append((length,horizontal,tilt,normal,offset))
    retained=[]
    for row in sorted(proposals,key=lambda p:-p[0]):
        if any(old[1]==row[1] and abs(old[2]-row[2])<2.4 and abs(old[4]-row[4])<3.5 for old in retained):
            continue
        retained.append(row)
    return lab,retained


def edge_contrast(lab, a, b):
    span=b-a
    length=np.linalg.norm(span)
    if length<20:
        return 0
    normal=np.array([-span[1],span[0]])/length
    points=a+np.linspace(.025,.975,65)[:,None]*span
    def pixels(offset):
        xy=np.rint(points+normal*offset).astype(int)
        return lab[xy[:,1],xy[:,0]].astype(float)
    change=np.linalg.norm(pixels(2.4)-pixels(-2.4),axis=1)
    return (change>14).mean()+.004*np.minimum(change,60).mean()


def jacket_quad(cv, rgb, selected):
    y,x=np.where(selected)
    if len(x)<350 or not 85<=np.ptp(x)<=340 or not 35<=np.ptp(y)<=200:
        return
    h,w=selected.shape
    if min(h,w)<140 or selected.size>800000:
        return
    center=np.array([x.mean(),y.mean()])
    lab,lines=line_candidates(cv,rgb,center)
    xx=np.percentile(x,[3,97]);yy=np.percentile(y,[3,97])
    def group(horizontal,sign):
        return [v for v in lines if v[1]==horizontal and sign*v[4]>10][:22]
    top,bottom=group(True,-1),group(True,1)
    left,right=group(False,1),group(False,-1)
    def parallel(a,b):return abs(a[2]-b[2])<4
    def point(a,b):
        return center+np.linalg.solve(np.stack([a[3],b[3]]),[a[4],b[4]])
    sample=np.c_[x,y][::max(1,len(x)//650)]-center
    def pairs(a,b,dimension):
        found=[]
        for v in a:
            for z in b:
                if not parallel(v,z):
                    continue
                size=abs(v[4]-z[4])
                if not .76*dimension<size<3.9*dimension:
                    continue
                direction=np.sign(z[4]-v[4])
                inside=((sample@v[3]-v[4])*direction>-3)&((sample@z[3]-z[4])*direction<3)
                if inside.mean()>.85:
                    found.append((v,z,size))
        return found
    best=None
    for t,b,hh in pairs(top,bottom,max(45,np.ptp(yy))):
        for l,r,ww in pairs(left,right,max(45,np.ptp(xx))):
            if not 1.12<hh/ww<1.95 or abs(t[2]-l[2])>6 or abs(b[2]-r[2])>6:
                continue
            q=np.array([point(t,l),point(t,r),point(b,r),point(b,l)])
            if np.min(q)<4 or np.max(q[:,0])>w-5 or np.max(q[:,1])>h-5:
                continue
            edges=[edge_contrast(lab,p,q[(i+1)%4]) for i,p in enumerate(q)]
            if min(edges)<.72 or np.median(edges)<1.01:
                continue
            lengths=np.array([t[0]/ww,r[0]/hh,b[0]/ww,l[0]/hh])
            if min(lengths)<.12 or np.max(lengths)<.34:
                continue
            score=sum(edges)+.40*np.minimum(lengths,1).sum()
            if best is None or score>best[0]:
                best=score,q
    if best is not None:
        return best[1].astype('f')


def printed_rows(cv, rgb, selected):
    from scipy.ndimage import gaussian_filter, distance_transform_edt
    h,w=selected.shape
    high,low=rgb.max(2).astype(int),rgb.min(2).astype(int)
    pale=(low>=226)&(high-low<35)
    dark=(high<165)&(high-low>=9)&selected
    hue=np.rint(cv.cvtColor(rgb,cv.COLOR_RGB2HSV)[:,:,0]/7.5).astype(int)%24
    near=distance_transform_edt(~pale)<5
    histogram=np.bincount(hue[dark&near],minlength=24)
    if histogram.sum()<200:
        return
    counts=histogram+np.roll(histogram,1)+np.roll(histogram,-1)
    peak=counts.argmax()
    if counts[peak]<.29*histogram.sum():
        return
    family=dark&(np.minimum((hue-peak)%24,(peak-hue)%24)<=2)
    black=(high<122)&selected&(distance_transform_edt(~family)<5.6)
    strokes=family|black
    # Require two separate baselines of lettering with substantial horizontal span.
    from scipy.ndimage import binary_closing, label, find_objects, maximum_filter1d
    rows=binary_closing(strokes.sum(1)>.085*w,structure=np.ones(7))
    bands,_=label(rows)
    supported=np.zeros(h,bool)
    count=0
    for ss, in find_objects(bands):
        row=strokes[ss]
        if row.any(0).sum()<.48*w or not 7<=len(row)<=.22*h:
            continue
        count+=1
        supported[max(0,ss.start-7):min(h,ss.stop+7)]=True
    if count<2:
        return
    near_rows=maximum_filter1d(supported.astype('u1'),size=59)>0
    strokes &= near_rows[:,None]
    density=gaussian_filter(strokes.astype('f'),9)
    extent=(distance_transform_edt(~strokes)<7) | ((density>.026)&supported[:,None])
    extent &= selected
    if not .055<extent.mean()<.55:
        return
    return extent


def prepare_plane(cv, rgb, mask):
    quad=jacket_quad(cv,rgb,mask)
    if quad is None:
        return
    edges=np.linalg.norm(quad-np.roll(quad,-1,axis=0),axis=1)
    height=512
    width=int(round(height*(edges[0]+edges[2])/(edges[1]+edges[3])))
    target=np.float32([[0,0],[width-1,0],[width-1,height-1],[0,height-1]])
    transform=cv.getPerspectiveTransform(quad,target)
    book=cv.warpPerspective(rgb,transform,(width,height),flags=cv.INTER_CUBIC)
    selected=cv.warpPerspective(mask.astype('u1'),transform,(width,height),flags=cv.INTER_NEAREST)>0
    printed=printed_rows(cv,book,selected)
    if printed is not None:
        return book,printed,transform


def title_row_opacity(printed):
    from scipy.ndimage import distance_transform_edt, gaussian_filter1d
    alpha = np.clip((4-distance_transform_edt(~printed))/3, 0, 1)
    width = np.count_nonzero(printed.any(0))
    profile = gaussian_filter1d(printed.sum(1).astype('f'), 2)
    rows = np.flatnonzero(profile > .36*width)
    runs = [group for group in np.split(rows, np.flatnonzero(np.diff(rows)>8)+1) if len(group)>12]
    if len(runs) < 2:
        return alpha
    first, last = runs[-2:]
    span = last[-1]-first[0]
    if not .13*len(printed) < span < .58*len(printed):
        return alpha
    y = np.arange(len(printed))
    # The small reading above the first row and the bright interline ornaments
    # belong to the same title as its dark faces.
    band = np.minimum(y-first[0]+.17*span, last[-1]+.10*span-y)
    return np.maximum(alpha, np.clip(band/5, 0, 1)[:, None])


def selected_volume_mark(cv, book, printed):
    """A light glyph inside an enclosed dark polygon has its own flat stock."""
    colour = cv.medianBlur(book, 3)
    for limit in (83, 99, 115):
        dark = (colour.max(2)<limit).astype('u1')
        contours = cv.findContours(dark, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)[0]
        h, w = dark.shape
        for contour in contours:
            x,y,cw,ch = cv.boundingRect(contour)
            if not (12<=cw<=.23*w and 12<=ch<=.16*h and .67<cw/ch<1.65):
                continue
            hull = cv.convexHull(contour)
            area = cv.contourArea(contour)
            if area < .60*cw*ch or area > .93*cw*ch or area < .89*cv.contourArea(hull):
                continue
            corners = cv.approxPolyDP(hull, .038*cv.arcLength(hull, True), True)
            if not 5<=len(corners)<=8:
                continue
            shape = np.zeros_like(dark)
            cv.drawContours(shape, [contour], 0, 1, -1)
            depth = cv.distanceTransform(shape, cv.DIST_L2, 5)
            inside = depth > max(2.8, .10*min(cw,ch))
            bank = inside & (dark>0)
            if bank.sum()<60 or not .54<bank.sum()/inside.sum()<.96:
                continue
            tone = np.median(colour[bank], axis=0)
            face = inside & (colour.min(2)>tone.max()+42)
            if not .035*inside.sum()<face.sum()<.32*inside.sum() or printed[face].mean()<.64:
                continue
            if np.quantile(np.max(abs(colour[bank]-tone), axis=1), .81)>21:
                continue
            yield inside, face, tone


def restore_volume_mark(cv, original, printed, edited, alpha):
    from scipy.ndimage import distance_transform_edt, gaussian_filter
    for inside, face, tone in selected_volume_mark(cv, original, printed):
        near = distance_transform_edt(~face)
        bank = inside & (near>3.5) & (np.max(abs(original.astype('f')-tone), axis=2)<18)
        if bank.sum()<48:
            continue
        # Check that this area is still a badge after Qwen reconstructed the
        # figures. A removed badge should remain part of its new illustration.
        agrees = np.max(abs(edited.astype('f')-tone), axis=2)<33
        if agrees[bank].mean()<.70:
            continue
        difference = np.max(abs(edited.astype('f')-tone), axis=2)
        glyph = inside & (near<6.5)
        if (glyph & (difference>29)).sum()<10:
            continue
        mass = gaussian_filter(bank.astype('f'), 6)
        paint = gaussian_filter(original.astype('f')*bank[:, :, None], (6,6,0))/np.maximum(mass[:, :, None], .001)
        paint[mass<.02] = tone
        edited[glyph] = np.rint(paint[glyph]).clip(0,255).astype('u1')
        alpha[glyph] = 1


def put_back(cv, source, selected, book, printed, edit, matrix, *, include_reading=False):
    from scipy.ndimage import distance_transform_edt
    if edit.shape!=book.shape or printed.shape!=book.shape[:2]:
        raise ValueError("Edited jacket and measured original must share a grid")
    size=source.shape[1],source.shape[0]
    alpha=title_row_opacity(printed).astype('f')
    edit=edit.copy()
    restore_volume_mark(cv,book,printed,edit,alpha)
    if include_reading:
        # A title on a tilted cover can cross the axis-aligned sampling mask.
        # Only the measured rows on the physical page may extend into its collar.
        selected = distance_transform_edt(~selected) < 15
        if source.shape[2] == 4:
            selected &= source[:, :, 3] == 255
    # Adding a rectified difference to the original leaves the high-frequency
    # part of small letters behind after the round trip through two pixel grids.
    # Transfer premultiplied colour directly on the original native grid.
    changed = np.max(abs(edit.astype('i2')-book.astype('i2')),axis=2)
    alpha *= cv.dilate((changed>2).astype('f'), np.ones((5,5),'u1'))
    interpolation=cv.INTER_LINEAR|cv.WARP_INVERSE_MAP
    weight=cv.warpPerspective(alpha,matrix,size,flags=interpolation)
    paint=cv.warpPerspective(edit.astype('f')*alpha[:,:,None],matrix,size,flags=interpolation)
    out=source.copy()
    out[selected,:3]=np.rint(source[selected,:3]*(1-weight[selected,None])+paint[selected]).clip(0,255).astype('u1')
    return out


if __name__=="__main__":
    import sys
    package,mode,src_path,stencil_path,stage=sys.argv[1:]
    sys.path.insert(0,str(Path(package).resolve()))
    import cv2
    folder=Path(stage)
    with Image.open(src_path) as im, Image.open(stencil_path) as stencil:
        source=np.asarray(im.convert("RGBA"))
        mask=(np.asarray(stencil.convert("L"))>127)&(source[:,:,3]==255)
    if mode=="prepare":
        plane=prepare_plane(cv2,source[:,:,:3],mask)
        if plane is None:
            print("unchanged")
        else:
            book,ink,matrix=plane
            Image.fromarray(book).save(folder/"book.png")
            Image.fromarray(ink.astype('u1')*255).save(folder/"ink.png")
            np.save(folder/"transform.npy",matrix,allow_pickle=False)
            print("applied")
    elif mode=="compose":
        def read(name,mode):
            with Image.open(folder/name) as image:
                return np.asarray(image.convert(mode))
        out=put_back(cv2,source,mask,read("book.png","RGB"),read("ink.png","L")>127,
                     read("edited.png","RGB"),np.load(folder/"transform.npy",allow_pickle=False),include_reading=True)
        Image.fromarray(out).save(folder/"native.png")
        print("applied")
    else:
        raise ValueError("Unknown jacket operation")
