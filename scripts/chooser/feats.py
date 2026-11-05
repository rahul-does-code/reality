# Per-candidate features from EfficientSAM's 3 low-res logit masks. Mirrored exactly in
# src/vision/samChooser.ts (keep both in sync).
import numpy as np
from scipy.ndimage import label
NF = 13
def features(L, pred, cx, cy):
    """L [3,256,256] logits, pred [3] predicted IoU, click (cx, cy) in 256-space -> [3, NF]."""
    M = L > 0
    area = M.reshape(3, -1).mean(1)
    la = np.log(area + 1e-4)
    stab = (L > 1).reshape(3, -1).sum(1) / np.maximum(1, (L > -1).reshape(3, -1).sum(1))
    rank = np.argsort(np.argsort(area, kind="stable"), kind="stable") / 2
    border = np.array([(m[0].sum() + m[-1].sum() + m[:, 0].sum() + m[:, -1].sum()) / 1024 for m in M])
    ix, iy = min(255, max(0, int(cx))), min(255, max(0, int(cy)))
    comp = np.zeros(3); dist = np.zeros(3); nest = np.zeros(3)
    for i, m in enumerate(M):
        n = m.sum()
        if n == 0: dist[i] = 3; continue
        lab, _ = label(m)  # 4-connectivity
        k = lab[iy, ix]
        comp[i] = (lab == k).sum() / n if k else 0
        ys, xs = np.nonzero(m)
        dist[i] = min(3, np.hypot(xs.mean() - cx, ys.mean() - cy) / np.sqrt(n))
        nest[i] = np.mean([(m & M[j]).sum() / max(1, M[j].sum()) for j in range(3) if j != i])
    return np.stack([pred, pred - pred.max(), la, la - la.max(), stab, rank, border, comp, dist, nest,
                     np.eye(3)[0], np.eye(3)[1], np.eye(3)[2]], 1).astype(np.float32)
