# Open Images train shard -> (embedding fp16 [256,64,64], masks [k,256,256] bool) per image.
import csv, os, sys, random, urllib.request, concurrent.futures as cf, numpy as np, onnxruntime as ort, io
from PIL import Image
random.seed(1)
SHARD, NIMG = sys.argv[1], int(sys.argv[2])
os.makedirs("emb", exist_ok=True)
have = set(os.listdir(f"masks{SHARD}"))
by_img = {}
with open("train-annotations-object-segmentation.csv") as f:
    for r in csv.DictReader(f):
        if r["ImageID"][0] == SHARD and r["MaskPath"] in have:
            by_img.setdefault(r["ImageID"], []).append(r["MaskPath"])
ids = sorted(by_img); random.shuffle(ids)
print(len(ids), "images with masks in shard", SHARD, flush=True)
so = ort.SessionOptions(); so.intra_op_num_threads = 4
enc = ort.InferenceSession("/home/user/evaldata/models/efficient_sam_vitt_encoder.onnx", so)
def fetch(iid):
    data = urllib.request.urlopen(f"https://open-images-dataset.s3.amazonaws.com/train/{iid}.jpg", timeout=30).read()
    img = Image.open(io.BytesIO(data)).convert("RGB")
    s = 1024 / max(img.size)
    if s < 1: img = img.resize((round(img.width * s), round(img.height * s)), Image.BILINEAR)
    masks = []
    for mp in by_img[iid]:
        m = Image.open(f"masks{SHARD}/{mp}").convert("L")
        a = np.asarray(m) > 127
        if not (0.005 <= a.mean() <= 0.45): continue
        masks.append(np.asarray(m.resize((256, 256), Image.BILINEAR)) > 127)
    return iid, img, masks
done = len(os.listdir("emb"))
todo = [i for i in ids if not os.path.exists(f"emb/{i}.npz")]
with cf.ThreadPoolExecutor(6) as ex:
    window = [ex.submit(fetch, i) for i in todo[:12]]
    nxt = 12
    while window and done < NIMG:
        f = window.pop(0)
        if nxt < len(todo):
            window.append(ex.submit(fetch, todo[nxt])); nxt += 1
        try: iid, img, masks = f.result()
        except Exception: continue
        if not masks: continue
        x = (np.asarray(img, np.float32) / 255).transpose(2, 0, 1)[None]
        emb = enc.run(None, {"batched_images": x})[0][0].astype(np.float16)
        np.savez(f"emb/{iid}.npz", emb=emb, masks=np.packbits(np.stack(masks), axis=-1), hw=np.array(img.size[::-1]))
        done += 1
        if done % 100 == 0: print(done, flush=True)
print("done", done)
