// Replace: send the command's self-contained edit prompt; caller composites inside the mask.
import { modelEdit } from "./modelEdit";
import type { Timeline } from "../commands/timeline";

export function replaceObject(
  original: ImageData,
  alpha: Float32Array,
  prompt: string,
  timeline?: Timeline,
): Promise<ImageBitmap> {
  return modelEdit(original, alpha, prompt, timeline);
}
