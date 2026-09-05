"""Small source-only expression classifier; no comic labels or Korean retrieval.

The input is an ink component, not an OCR-aligned character. Incomplete glyphs
are present in synthetic training through the exact same component extractor.
"""
import argparse
import hashlib
import json
import math
import random
import time
from pathlib import Path

import cv2
import numpy as np
import torch
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont
from torch import nn
from torch.nn import functional as F

CLASSES = ["body", "scribble", "brush", "heavy_sans", "heavy_serif", "display"]
HAND = {"kleeone", "yomogi", "slacksideone", "zenkurenaido"}
BRUSH = {"yujiboku", "yujimai", "yujisyuku", "yusei-magic"}
DISPLAY = {"reggae-one", "rocknrollone", "pottaone", "aoboshione", "hachi-maru-pop",
           "cherrybombone", "chokokutai", "darumadropone", "palettemosaic", "rampartone",
           "rock3d", "shizuru", "stick", "trainone", "dot-gothic-16", "kapakana"}
POLICY = {
    "id": "source-ink-expression-cnn-v1", "seed": 732611,
    "hypothesis": "Component-level source morphology can detect scribbles and extreme weight without correct OCR glyph correspondence or a four-character group gate.",
    "differenceFromGlyphVoice": "Classify six Japanese source treatments from isolated/partial ink components; no Korean glyph generation, candidate IDs, style-vector clustering, or cross-script distance.",
    "training": "Verified existing OFL font pack only. No comic pixels, user screenshots, v11, or direct visual labels.",
    "validation": "Deterministic held-out character identities and separate named Japanese families; source-only sanity check, not comic quality evidence.",
    "input": "Otsu minority ink, 8-connected components, aspect-preserving 48px ink in 64px canvas, largest at most 16 components, no OCR count or source style labels.",
    "augmentation": "Rotation +/-20 degrees, scale, shear, uneven stroke rasterization, low-resolution resampling, fragments from real connected-component extraction; applied equally to every type.",
    "decision": "Median component probabilities; >=0.8 confidence, >=0.3 winner margin, at least two components. Body/display/uncertain preserve baseline.",
    "fontMap": {"scribble": "start-over", "brush": "griun-pol-sensibility", "heavy_sans": "black-han-sans", "heavy_serif": "griun-pol-sensibility"},
    "success": "Actual 93-region chapter recovers clear handwriting and heavy examples without ordinary dialogue becoming expressive. All changed and normal regions viewed. Then an unused chapter and production-path verification.",
    "reject": "Ordinary body turns into scribbles/strong display, effect treatment is flattened, or isolated gains do not survive whole-chapter viewing.",
    "productCandidateOrdinal002": 4,
}


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical(mask):
    yy, xx = np.nonzero(mask)
    if not len(xx):
        return None
    crop = mask[yy.min():yy.max() + 1, xx.min():xx.max() + 1]
    scale = 48 / max(crop.shape)
    h, w = max(1, round(crop.shape[0] * scale)), max(1, round(crop.shape[1] * scale))
    small = cv2.resize(crop.astype(np.float32), (w, h), interpolation=cv2.INTER_LINEAR)
    out = np.zeros((64, 64), np.float32)
    out[(64 - h) // 2:(64 - h) // 2 + h, (64 - w) // 2:(64 - w) // 2 + w] = small
    return out


def components(gray, maximum=16):
    threshold, mask = cv2.threshold(gray, 0, 1, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    if mask.mean() > .5:
        mask = 1 - mask
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    height, width = mask.shape
    kept = []
    for i in range(1, n):
        x, y, w, h, area = (int(v) for v in stats[i])
        if area < 8 or min(w, h) < 3 or max(w / h, h / w) > 4:
            continue
        if (x == 0 or y == 0 or x + w == width or y + h == height) and max(w / h, h / w) > 2:
            continue
        kept.append((area, x, y, w, h, i))
    kept.sort(key=lambda c: (-c[0], c[2], c[1]))
    if kept:
        cutoff = kept[0][0] * .07
        kept = [c for c in kept if c[0] >= cutoff][:maximum]
    output = []
    for area, x, y, w, h, i in kept:
        tile = canonical((labels[y:y+h, x:x+w] == i).astype(np.uint8))
        output.append({"image": tile, "bbox": [x, y, x+w, y+h], "area": area})
    return output, int(threshold)


class ExpressionNet(nn.Module):
    def __init__(self):
        super().__init__()
        channels = [1, 24, 48, 72, 96]
        layers = []
        for i in range(4):
            layers += [nn.Conv2d(channels[i], channels[i+1], 3, stride=2, padding=1, bias=False), nn.BatchNorm2d(channels[i+1]), nn.ReLU(),
                       nn.Conv2d(channels[i+1],channels[i+1],3,padding=1,bias=False),nn.BatchNorm2d(channels[i+1]),nn.ReLU()]
        self.features = nn.Sequential(*layers)
        self.head = nn.Linear(192, len(CLASSES))

    def forward(self, x):
        x = self.features(x)
        mean = x.mean((2, 3))
        maximum = x.amax((2, 3))
        return self.head(torch.cat([mean, maximum], 1))


def family_class(sid):
    if "hentaigana" in sid:
        return None
    for tokens, label in [(HAND, 1), (BRUSH, 2), (DISPLAY, 5)]:
        if any(token in sid for token in tokens):
            return label
    if sid in {"dela-gothic-one", "noto-sans-cjk-kr-black"}:
        return 3
    if sid in {"noto-serif-cjk-kr-black", "noto-serif-cjk-kr-bold"}:
        return 4
    return 0


def make_data(assets, output):
    output.mkdir(parents=True, exist_ok=False)
    write(output / "protocol.json", POLICY)
    rng = np.random.default_rng(POLICY["seed"])
    manifest = read(assets / "artifacts/manga-font-glyphvoice-ofl-source-pack-v2/source-manifest.json")
    data, target, split, inventory = [], [], [], []
    # Named family holdout is fixed before rendering or examining any comics.
    holdout = {"gf-zenkurenaido-zenkurenaido-regular", "gf-yujimai-yujimai-regular", "gf-shipporimincho-shipporimincho-regular", "gf-mplus1p-mplus1p-regular", "dela-gothic-one", "gf-rocknrollone-rocknrollone-regular"}
    for row in manifest["sources"]:
        if row.get("locale_hint") not in {"ja", "bridge_candidate"}:
            continue
        sid = row["source_id"]
        label = family_class(sid)
        if label is None:
            continue
        path = assets / row["font_file"]
        if not row["license"]["training_allowed"] or sha(path) != row["font_sha256"]:
            raise ValueError("Unverified font " + sid)
        with TTFont(path, fontNumber=row["face_index"]) as table:
            cmap = table.getBestCmap() or {}
        available = [c for c in cmap if (0x3041 <= c <= 0x30fa or 0x4e00 <= c <= 0x9fff) and cmap[c] != ".notdef"]
        kana = [c for c in available if c < 0x4e00]
        kanji = [c for c in available if c >= 0x4e00]
        # Balance classes without using measured performance to choose counts.
        count = 320 if label == 0 else 1200
        if len(available) < 100:
            continue
        fonts = {size: ImageFont.truetype(str(path), size, index=row["face_index"]) for size in (20, 28, 40, 56, 72)}
        before = len(data)
        for j in range(count):
            character_pool = kana if j % 2 == 0 and kana else (kanji or available)
            codepoint = int(rng.choice(character_pool))
            size = int(rng.choice(list(fonts)))
            font = fonts[size]
            image = Image.new("L", (size*3, size*3), 255)
            box = font.getbbox(chr(codepoint))
            ImageDraw.Draw(image).text((size-box[0],size-box[1]),chr(codepoint),font=font,fill=0)
            angle = float(rng.uniform(-20,20))
            image = image.rotate(angle, resample=Image.Resampling.BICUBIC, fillcolor=255)
            gray = np.asarray(image)
            if j % 3 == 0:
                reduced = int(rng.integers(30, 90))
                gray = cv2.resize(cv2.resize(gray,(reduced,reduced),interpolation=cv2.INTER_AREA),gray.shape[::-1],interpolation=cv2.INTER_LINEAR)
            tiles, _ = components(gray, 3)
            for tile in tiles:
                data.append(np.rint(tile["image"]*255).astype(np.uint8))
                target.append(label)
                split.append(2 if sid in holdout else (1 if codepoint % 5 == 0 else 0))
        inventory.append({"id":sid,"class":CLASSES[label],"fontSha256":row["font_sha256"],"familyHoldout":sid in holdout,"components":len(data)-before})
        print(sid, len(data)-before, flush=True)
    np.savez_compressed(output/'data.npz',x=np.stack(data),y=np.array(target,np.int64),split=np.array(split,np.uint8))
    write(output/'inventory.json',{'faces':inventory,'samples':len(data),'classes':CLASSES,'scriptSha256':sha(Path(__file__))})


def train(data_dir, output):
    output.mkdir(parents=True,exist_ok=False)
    torch.set_num_threads(4)
    torch.manual_seed(POLICY['seed']);np.random.seed(POLICY['seed']);random.seed(POLICY['seed'])
    torch.backends.cudnn.benchmark=False
    started=time.perf_counter()
    raw=np.load(data_dir/'data.npz');x=torch.from_numpy(raw['x']).to('cuda',dtype=torch.float32)[:,None]/255
    y=torch.from_numpy(raw['y']).to('cuda');split=raw['split']
    groups=[torch.from_numpy(np.flatnonzero((split==0)&(raw['y']==c))).to('cuda') for c in range(len(CLASSES))]
    model=ExpressionNet().cuda();optim=torch.optim.AdamW(model.parameters(),lr=.002,weight_decay=.0001)
    losses=[]
    for step in range(12000):
        model.train()
        ids=torch.cat([g[torch.randint(len(g),(32,),device='cuda')] for g in groups])
        bx=x[ids]; by=y[ids]
        # Shared pose augmentation must not teach that skew itself means handwriting.
        theta=torch.zeros((len(ids),2,3),device='cuda');theta[:,0,0]=torch.empty(len(ids),device='cuda').uniform_(.85,1.15);theta[:,1,1]=torch.empty(len(ids),device='cuda').uniform_(.85,1.15)
        theta[:,0,1]=torch.empty(len(ids),device='cuda').uniform_(-.12,.12);theta[:,:,2]=torch.empty((len(ids),2),device='cuda').uniform_(-.08,.08)
        bx=F.grid_sample(bx,F.affine_grid(theta,bx.shape,align_corners=False),align_corners=False)
        logits=model(bx);loss=F.cross_entropy(logits,by,label_smoothing=.025)
        optim.zero_grad(set_to_none=True);loss.backward();optim.step()
        for group in optim.param_groups: group['lr']=.00005+.00195*(1+math.cos(math.pi*step/12000))/2
        if step % 200==0:
            losses.append({'step':step,'loss':float(loss.detach()),'elapsed':time.perf_counter()-started});print(json.dumps(losses[-1]),flush=True)
    model.eval();valid=[]
    with torch.inference_mode():
        for s in (1,2):
            ids=np.flatnonzero(split==s);pred=[]
            for offset in range(0,len(ids),256):pred.extend(model(x[ids[offset:offset+256]]).argmax(1).cpu().tolist())
            matrix=np.zeros((len(CLASSES),len(CLASSES)),dtype=int)
            for a,b in zip(raw['y'][ids],pred):matrix[a,b]+=1
            valid.append({'split':s,'count':len(ids),'accuracy':float(np.trace(matrix)/matrix.sum()),'confusion':matrix.tolist()})
    torch.save(model.cpu().state_dict(),output/'model.pt')
    torch.onnx.export(model.cpu(),torch.zeros(2,1,64,64),str(output/'model.onnx'),input_names=['ink'],output_names=['logits'],dynamic_axes={'ink':{0:'components'},'logits':{0:'components'}},opset_version=17,dynamo=False)
    write(output/'receipt.json',{'policy':POLICY,'modelSha256':sha(output/'model.onnx'),'modelBytes':(output/'model.onnx').stat().st_size,'dataSha256':sha(data_dir/'data.npz'),'sourceInventorySha256':sha(data_dir/'inventory.json'),'scriptSha256':sha(Path(__file__)),'steps':12000,'losses':losses,'validation':valid,'elapsedSeconds':time.perf_counter()-started})
    print(json.dumps(valid),flush=True)


def infer(chapter, model_dir, output):
    import onnxruntime as ort
    output.mkdir(parents=True,exist_ok=False);write(output/'protocol.json',POLICY)
    session=ort.InferenceSession(str(model_dir/'model.onnx'),providers=['CPUExecutionProvider'])
    results=[];patches=[];started=time.perf_counter()
    for page in read(chapter/'ocr-baseline/baseline-report.json')['pages']:
        pid=page['pageId'];image=Image.open(chapter/'ocr-baseline'/page['ocrImagePath'] if page.get('ocrImagePath') else page['imagePath']).convert('L')
        baseline=read(chapter/'baseline'/pid/'page.json') if (chapter/'baseline'/pid/'page.json').exists() else None
        for i,candidate in enumerate(page['candidates']):
            key=pid+'/'+candidate['candidateId'];b=candidate['bbox'];box=[math.floor(b['x1']),math.floor(b['y1']),math.ceil(b['x2']),math.ceil(b['y2'])]
            tiles,threshold=components(np.asarray(image.crop(box)))
            probs=[]
            if tiles:
                scores=session.run(None,{'ink':np.stack([t['image'] for t in tiles])[:,None]})[0];scores-=scores.max(1,keepdims=True);prob=np.exp(scores);prob/=prob.sum(1,keepdims=True)
                probs=np.median(prob,axis=0);probs/=probs.sum()
            order=np.argsort(probs)[::-1] if len(probs) else []
            winner=CLASSES[order[0]] if len(order) else 'none';conf=float(probs[order[0]]) if len(order) else 0;margin=float(probs[order[0]]-probs[order[1]]) if len(order) else 0
            applied=winner in POLICY['fontMap'] and conf>=.8 and margin>=.3 and len(tiles)>=2
            base=baseline['blocks'][i] if baseline else {'fontFamily':'ridi-batang','bold':False,'italic':False}
            row={'key':key,'fontId':POLICY['fontMap'][winner] if applied else base['fontFamily'],'fontWeight':400 if applied else (700 if base['bold'] else 400),'italic':False if applied else base['italic'],'status':'expression_inferred' if applied else 'preserve_baseline','type':winner,'confidence':conf,'margin':margin,'probabilities':list(map(float,probs)),'components':len(tiles),'threshold':threshold,'bbox':box,'componentBoxes':[t['bbox'] for t in tiles]}
            results.append(row)
            if tiles:
                montage=np.full((64,64*len(tiles)),255,np.uint8)
                for j,t in enumerate(tiles):montage[:,j*64:(j+1)*64]=np.rint(255*(1-t['image'])).astype(np.uint8)
                name=key.replace('/','-')+'.png';Image.fromarray(montage).save(output/name);row['componentImage']=name
    write(output/'choices.json',{'policy':POLICY,'modelSha256':sha(model_dir/'model.onnx'),'choices':results,'elapsedSeconds':time.perf_counter()-started})
    write(output/'palette.json',{'fontIds':sorted({r['fontId'] for r in results})})
    print(json.dumps({'rows':len(results),'changed':sum(r['status']=='expression_inferred' for r in results),'elapsed':time.perf_counter()-started}))


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['data','train','infer']);parser.add_argument('input',type=Path);parser.add_argument('output',type=Path);parser.add_argument('--model',type=Path)
    args=parser.parse_args()
    if args.mode=='data':make_data(args.input.resolve(),args.output.resolve())
    elif args.mode=='train':train(args.input.resolve(),args.output.resolve())
    else:infer(args.input.resolve(),args.model.resolve(),args.output.resolve())
