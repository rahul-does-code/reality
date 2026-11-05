# SAM candidate chooser

EfficientSAM returns 3 candidate masks per click; its own pick (highest predicted IoU) is often a
part of the object. This trains a tiny MLP (13 features -> 16 -> 1, softmax over the candidates)
on Open Images whole-object masks to pick the whole object. Output: `src/vision/samChooserWeights.ts`.

Held-out Open Images val (400 objects x 2 clicks): SAM's pick 0.589 mIoU -> chooser 0.700
(best of the 3 candidates: 0.806).

Steps (Python 3 with numpy, scipy, pillow, onnxruntime; paths at the top of each script point at
/home/user/traindata and /home/user/evaldata, edit as needed):

1. `scripts/eval-prep.py` builds the val set (Open Images v5 validation masks + images).
2. `prep_train.py <shard> <n>` downloads Open Images train images for one mask shard and stores
   the EfficientSAM-Ti image embedding plus the 256x256 masks per image.
3. `dump.py train` and `dump.py val` run the stock decoder with simulated clicks and save the
   candidate features (`feats.py`, mirrored by `src/vision/samChooser.ts`) and true IoUs.
4. `train.py` trains, selects on train only, reports val and writes the weights.

`npm run test:chooser` checks the TypeScript features against Python's.
