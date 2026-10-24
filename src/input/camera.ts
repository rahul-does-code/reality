// Camera source. Swappable later (phone camera via browser, glasses relay).
// Everything downstream only needs a playing <video> element.

let startToken = 0; // guards against overlapping starts (React StrictMode runs effects twice in dev)

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "videoinput");
}

export async function startCamera(
  video: HTMLVideoElement,
  deviceId?: string
): Promise<MediaStream> {
  const token = ++startToken;
  stopCamera(video);
  const stream = await navigator.mediaDevices.getUserMedia({
    video: deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
      : { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: "environment" },
    audio: false,
  });
  if (token !== startToken) {
    // A newer start superseded this one: release this stream instead of leaking it.
    stream.getTracks().forEach((t) => t.stop());
    return stream;
  }
  video.srcObject = stream;
  try {
    await video.play();
  } catch (e) {
    if (!(e instanceof DOMException && e.name === "AbortError")) throw e;
  }
  return stream;
}

export function stopCamera(video: HTMLVideoElement) {
  const stream = video.srcObject as MediaStream | null;
  stream?.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
}
