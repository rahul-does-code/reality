# Run the stock EfficientSAM decoder on precomputed embeddings with simulated clicks; save
# candidate features + true IoU vs the whole-object mask (all at 256x256, the stretched frame).
import glob, json, sys, random, numpy as np, onnxruntime as ort
from scipy.ndimage import distance_transform_edt
from PIL import Image
from feats import features
random.seed(3)
so = ort.SessionOptions(); so.intra_op_num_threads = 2
dec = ort.InferenceSession("/home/user/evaldata/models/efficient_sam_vitt_decoder.onnx", so)
def run(emb, cx, cy):
    m, iou, _ = dec.run(None, {"image_embeddings": emb[None].astype(np.float32), "batched_point_coords": np.array([[[[cx, cy]]]], np.float32),
                               "batched_point_labels": np.array([[[1]]], np.float32), "orig_im_size": np.array([256, 256], np.int64)})
    return m[0, 0], iou[0, 0]
def clicks(m, n):
    d = distance_transform_edt(np.pad(m, 1))[1:-1, 1:-1]
    cy, cx = np.unravel_index(d.argmax(), d.shape); out = [(cx + .5, cy + .5)]
    ys, xs = np.nonzero(d >= 0.3 * d.max())
    for _ in range(n - 1):
        k = random.randrange(len(xs)); out.append((xs[k] + random.random(), ys[k] + random.random()))
    return out
X, Y, G = [], [], []
which = sys.argv[1]
if which == "train":
    for gi, f in enumerate(sorted(glob.glob("/home/user/traindata/emb/*.npz"))):
        z = np.load(f); ms = np.unpackbits(z["masks"], axis=-1)[..., :256].astype(bool)
        for m in ms[np.random.RandomState(gi).permutation(len(ms))[:3]]:
            if m.sum() < 20: continue
            for cx, cy in clicks(m, 2):
                L, p = run(z["emb"], cx, cy)
                X.append(features(L, p, cx, cy)); Y.append([((L[i] > 0) & m).sum() / max(1, ((L[i] > 0) | m).sum()) for i in range(3)]); G.append(gi)
else:
    idx = json.load(open("/home/user/evaldata/set/index.json")); vemb = np.load("/home/user/evaldata/val_emb.npy")
    for gi, it in enumerate(idx):
        m = np.asarray(Image.open(f"/home/user/evaldata/set/gt/{it['id']}.png").resize((256, 256), Image.BILINEAR)) > 127
        for k in ("center", "rand"):
            cx, cy = (it[k][0] + .5) * 256 / it["w"], (it[k][1] + .5) * 256 / it["h"]
            L, p = run(vemb[gi], cx, cy)
            X.append(features(L, p, cx, cy)); Y.append([((L[i] > 0) & m).sum() / max(1, ((L[i] > 0) | m).sum()) for i in range(3)]); G.append(gi)
np.savez(f"{which}.npz", X=np.array(X), Y=np.array(Y), G=np.array(G)); print(which, len(X))
