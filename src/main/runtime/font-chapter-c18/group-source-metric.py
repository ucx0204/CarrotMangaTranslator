"""S5 grouping: source-only, script-aware distances; no fixed cluster count."""
import argparse,hashlib,json
from pathlib import Path
import numpy as np
import onnxruntime as ort
from PIL import Image

read=lambda p:json.loads(p.read_text('utf-8'))
write=lambda p,v:p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n','utf-8')
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
POLICY={
 'id':'script-aware-source-metric-complete-link-s5',
 'distance':'Maximum cosine distance over jointly observed kana/kanji means. No averaging the two scripts into a single type.',
 'threshold':'Frozen 1st percentile of different-face distances among held-out OFL families; no tuning on manga crops.',
 'anchors':'At least 2 verified glyphs in a compared script. No four-character block gate. Other blocks remain explicit unresolved singletons.',
 'linkage':'Deterministic complete-link. Every cross-pair must pass; no chained merges, no preset k.',
 'selection':'None. Korean choices and user visual labels are never read.',
}

def distance(a,b):
 values=[]
 for script in ['kana','kanji']:
  if a['counts'][script]>=2 and b['counts'][script]>=2:
   values.append(max(0,float(1-np.dot(a['vectors'][script],b['vectors'][script]))))
 return max(values) if values else 2.

def run(chapter,glyphs,model_dir,output):
 output.mkdir(parents=True,exist_ok=False)
 receipt=read(model_dir/'receipt.json')
 threshold=next(r['threshold'] for r in receipt['calibration'] if r['familyHoldout'])
 options=ort.SessionOptions();options.intra_op_num_threads=2
 session=ort.InferenceSession(str(model_dir/'model.onnx'),sess_options=options,providers=['CPUExecutionProvider'])
 analysis=read(glyphs/'analysis.json')
 # Evaluation inventory follows the frozen real application inputs. Excluded
 # covers/publisher/non-text regions cannot silently enter source groups.
 eligible=set()
 for p in (chapter/'baseline').glob('P*/font-page.json'):
  ev=read(p)
  eligible.update(p.parent.name+'/'+r['candidate']['candidateId'] for r in ev['inputs'])
 rows=[]
 for b in analysis['blocks']:
  if b['key'] not in eligible:continue
  scripts={'kana':[],'kanji':[]}
  for g in b['glyphs']:
   code=ord(g['character'])
   name='kana' if 0x3040<=code<=0x30ff else 'kanji' if 0x4e00<=code<=0x9fff else None
   if name is None:continue
   tile=1-np.asarray(Image.open(glyphs/g['image']).convert('L'),np.float32)/255
   scripts[name].append(tile)
  vectors={};counts={}
  for name,tiles in scripts.items():
   counts[name]=len(tiles)
   if not tiles: vectors[name]=[0.]*96;continue
   encoded=session.run(None,{'glyph':np.stack(tiles)[:,None]})[0]
   mean=encoded.mean(0);mean/=max(1e-6,np.linalg.norm(mean));vectors[name]=mean.tolist()
  rows.append({'key':b['key'],'source':b['sourceText'],'counts':counts,'vectors':vectors})
 by_key={r['key']:r for r in rows}
 for key in eligible-by_key.keys():
  row={'key':key,'source':'','counts':{'kana':0,'kanji':0},'vectors':{'kana':[0.]*96,'kanji':[0.]*96}}
  rows.append(row)
 rows.sort(key=lambda r:r['key'])
 matrix=np.array([[distance(a,b) for b in rows] for a in rows])
 clusters=[{i} for i in range(len(rows))]
 edges=sorted((matrix[i,j],i,j) for i in range(len(rows)) for j in range(i+1,len(rows)) if matrix[i,j]<=threshold)
 for d,i,j in edges:
  left=next(g for g in clusters if i in g);right=next(g for g in clusters if j in g)
  if left is right:continue
  if max(matrix[a,b] for a in left for b in right)>threshold:continue
  clusters.remove(left);clusters.remove(right);clusters.append(left|right)
 groups=[]
 for ids in sorted(clusters,key=lambda c:(-len(c),min(rows[i]['key'] for i in c))):
  members=sorted(rows[i]['key'] for i in ids)
  prototype=min(ids,key=lambda i:(sum(matrix[i,j] for j in ids if i!=j),rows[i]['key']))
  groups.append({'id':'SG5-'+hashlib.sha256('|'.join(members).encode()).hexdigest()[:12],'members':members,'prototype':rows[prototype]['key'],'diameter':float(max((matrix[i,j] for i in ids for j in ids if i!=j),default=0)),'status':'source_group' if len(members)>1 else 'unresolved_singleton'})
 payload={'policy':POLICY,'threshold':threshold,'chapter':chapter.name,'modelSha256':sha(model_dir/'model.onnx'),'glyphAnalysisSha256':sha(glyphs/'analysis.json'),'groups':groups,'rows':rows,'sourceOnly':True}
 write(output/'groups.json',payload)
 np.savez_compressed(output/'distances.npz',distance=matrix,keys=np.array([r['key'] for r in rows]))
 print({'blocks':len(rows),'repeatedGroups':sum(len(g['members'])>1 for g in groups),'groupedBlocks':sum(len(g['members']) for g in groups if len(g['members'])>1),'sizes':[len(g['members']) for g in groups],'threshold':threshold},flush=True)

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('chapter',type=Path);parser.add_argument('glyphs',type=Path);parser.add_argument('model',type=Path);parser.add_argument('output',type=Path);a=parser.parse_args();run(a.chapter.resolve(),a.glyphs.resolve(),a.model.resolve(),a.output.resolve())
