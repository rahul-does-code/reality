// Replace: send the command's self-contained edit prompt; caller composites inside the mask.
import { modelEdit } from "./modelEdit";

export function replaceObject(original: ImageData, alpha: Float32Array, prompt: string): Promise<ImageBitmap> {
  return modelEdit(original, alpha, prompt);
}
