// Remove: ask the image model to erase the masked object; caller composites inside the mask.
import { modelEdit } from "./modelEdit";

export const REMOVE_PROMPT = "remove the masked object and fill in the background naturally";

export function removeObject(original: ImageData, alpha: Float32Array): Promise<ImageBitmap> {
  return modelEdit(original, alpha, REMOVE_PROMPT);
}
