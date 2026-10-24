// Remove: ask the image model to erase the masked object; caller composites inside the mask.
import { modelEdit } from "./modelEdit";
import type { Timeline } from "../commands/timeline";

export const REMOVE_PROMPT = "remove the masked object and fill in the background naturally";

export function removeObject(original: ImageData, alpha: Float32Array, timeline?: Timeline): Promise<ImageBitmap> {
  return modelEdit(original, alpha, REMOVE_PROMPT, timeline);
}
