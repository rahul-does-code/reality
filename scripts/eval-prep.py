import csv, random, os, json, numpy as np, urllib.request, concurrent.futures as cf
from PIL import Image
from scipy.ndimage import distance_transform_edt
random.seed(7)
names = {r[0]: r[1] for r in csv.reader(open("classes.csv"))}
have = set(os.listdir("masks"))
rows = [r for r in csv.DictReader(open("validation-annotations-object-segmentation.csv")) if r["MaskPath"] in have]
random.shuffle(rows)
os.makedirs("set/img", exist_ok=True); os.makedirs("set/gt", exist_ok=True)
seen, picked, per_class = set(), [], {}
def fetch(r):
    iid = r["ImageID"]
    p = f"set/img/{iid}.jpg"
    if not os.path.exists(p):
        urllib.request.urlretrieve(f"https://open-images-dataset.s3.amazonaws.com/validation/{iid}.jpg", p + ".tmp"); os.rename(p + ".tmp", p)
    return r
cands = []
for r in rows:
    if r["ImageID"] in seen: continue
    cls = names.get(r["LabelName"], r["LabelName"])
    if per_class.get(cls, 0) >= 8: continue
    m = np.array(Image.open("masks/" + r["MaskPath"]).convert("L")) > 127
    cov = m.mean()
    if not (0.005 <= cov <= 0.40): continue
    seen.add(r["ImageID"]); per_class[cls] = per_class.get(cls, 0) + 1
    cands.append((r, cls))
    if len(cands) >= 440: break
with cf.ThreadPoolExecutor(16) as ex:
    futs = {ex.submit(fetch, r): (r, cls) for r, cls in cands}
    for f in cf.as_completed(futs):
        r, cls = futs[f]
        try: f.result()
        except Exception as e: print("skip", r["ImageID"], e); continue
        img = Image.open(f"set/img/{r['ImageID']}.jpg").convert("RGB")
        s = 1280 / max(img.size)
        W, H = round(img.width * s), round(img.height * s)
        img = img.resize((W, H), Image.BICUBIC); img.save(f"set/img/{r['ImageID']}.jpg", quality=92)
        m = np.array(Image.open("masks/" + r["MaskPath"]).convert("L").resize((W, H), Image.BILINEAR)) > 127
        if m.sum() < 50: continue
        Image.fromarray((m * 255).astype(np.uint8)).save(f"set/gt/{r['ImageID']}.png")
        d = distance_transform_edt(np.pad(m, 1))[1:-1, 1:-1]
        cy, cx = np.unravel_index(d.argmax(), d.shape)
        ys, xs = np.nonzero(d >= 0.3 * d.max())
        rng = random.Random(r["ImageID"]); k = rng.randrange(len(xs))
        picked.append(dict(id=r["ImageID"], cls=cls, w=W, h=H, cov=float(m.mean()), center=[int(cx), int(cy)], rand=[int(xs[k]), int(ys[k])]))
picked = picked[:400]
json.dump(picked, open("set/index.json", "w"))
print(len(picked), "items,", len({p["cls"] for p in picked}), "classes")
