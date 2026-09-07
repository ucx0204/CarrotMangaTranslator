"""S6: pool verified characters across S5 groups, with direct pixel support.

Registered before running S6. This is source grouping, not a Korean font policy.
S5's per-sentence worst pair fragmented one face by character composition.
Pool evidence only when both metric centroids and shared-character rasters agree.
No target group count, Korean choices, manual labels or manga-trained weights.
"""
import argparse,hashlib,json
from pathlib import Path
import numpy as np

read=lambda p:json.loads(p.read_text('utf-8'))
POLICY={
 'id':'verified-glyph-pooling-s6',
 'startingGroups':'Immutable S5 complete-link groups, including unresolved singletons.',
 'metric':'Maximum cosine distance of pooled kana/kanji centroids; same frozen synthetic S5 cutoff.',
 'pixelSupport':'At least 3 distinct shared characters; median of per-character median observed distances <= frozen within-block S3 90th percentile.',
 'merge':'Closest passing pair; recompute all pooled evidence after each merge; deterministic tie breaks.',
 'authority':'Source-only development diagnostic. No Korean choices or user labels read.',
 'acceptance':'Visually audit group purity and fragmentation across all members, including P024/P025 rounded pair and P019 ordinary vs handwritten.',
}

def run(s5,glyphs,output):
 output.mkdir(parents=True,exist_ok=False)
 (output/'protocol.json').write_text(json.dumps(POLICY,ensure_ascii=False,indent=2),'utf-8')
 source=read(s5/'groups.json'); verified=read(glyphs/'analysis.json'); rows={r['key']:r for r in source['rows']}
 pixel_cutoff=verified['summary']['cutoff']; metric_cutoff=source['threshold']
 pairs={tuple(sorted((p['left'],p['right']))):p for p in verified['pairs']}
 clusters=[set(g['members']) for g in source['groups']]; history=[]
 def centroid(keys,script):
  selected=[rows[k] for k in sorted(keys) if rows[k]['counts'][script]>0]
  if sum(r['counts'][script] for r in selected)<2:return None
  # Equal block weight prevents a long passage from erasing a short voice.
  vector=np.mean([r['vectors'][script] for r in selected],axis=0)
  return vector/max(1e-6,np.linalg.norm(vector))
 def compare(a,b):
  if pixel_cutoff is None:return None
  distances=[]
  for script in ['kana','kanji']:
   va,vb=centroid(a,script),centroid(b,script)
   if va is not None and vb is not None:distances.append(max(0.,float(1-np.dot(va,vb))))
  if not distances or max(distances)>metric_cutoff:return None
  chars={}
  for ka in sorted(a):
   for kb in sorted(b):
    pair=pairs.get(tuple(sorted((ka,kb))))
    if pair:
     for e in pair['evidence']:chars.setdefault(e['character'],[]).append(e['distance'])
  if len(chars)<3:return None
  pixel=float(np.median([np.median(v) for v in chars.values()]))
  if pixel>pixel_cutoff:return None
  return {'metric':max(distances),'pixel':pixel,'distinctCharacters':len(chars)}
 while True:
  proposals=[]
  for i,a in enumerate(clusters):
   for j in range(i+1,len(clusters)):
    evidence=compare(a,clusters[j])
    if evidence:proposals.append((evidence['metric'],min(a),min(clusters[j]),i,j,evidence))
  if not proposals:break
  _,_,_,i,j,evidence=min(proposals)
  a,b=clusters[i],clusters[j]
  history.append({'left':sorted(a),'right':sorted(b),**evidence})
  clusters=[c for index,c in enumerate(clusters) if index not in (i,j)]+[a|b]
 groups=[]
 for keys in sorted(clusters,key=lambda k:(-len(k),min(k))):
  members=sorted(keys); group_id='SG6-'+hashlib.sha256('|'.join(members).encode()).hexdigest()[:12]
  groups.append({'id':group_id,'members':members,'status':'source_group' if len(keys)>1 else 'unresolved_singleton'})
 result={**source,'policy':POLICY,'groups':groups,'mergeHistory':history,'pixelCutoff':pixel_cutoff,
         's5Sha256':hashlib.sha256((s5/'groups.json').read_bytes()).hexdigest()}
 (output/'groups.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),'utf-8')
 print(json.dumps({'sizes':[len(g['members']) for g in groups],'merges':len(history)},ensure_ascii=False),flush=True)

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('s5',type=Path);p.add_argument('glyphs',type=Path);p.add_argument('output',type=Path);a=p.parse_args();run(a.s5.resolve(),a.glyphs.resolve(),a.output.resolve())
