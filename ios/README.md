# Glasses Relay (iPhone app)

Gets camera frames from **Meta's Wearables Device Access Toolkit (DAT)** and streams them to the laptop,
so the web app's input comes from the toolkit instead of the webcam.

There are no glasses here, so the app uses the toolkit's **Mock Device Kit**: it pairs a simulated
Ray-Ban Meta, and the toolkit delivers that device's camera stream through the same API real glasses
use (`DeviceSession` -> `addCamera` -> `stream.videoFramePublisher`). The mock's camera feed is:
- on a real iPhone: the **phone's back camera** (`setCameraFeed(cameraFacing: .back)`)
- in the iOS Simulator: a bundled test-pattern clip, `GlassesRelay/mock-feed.mp4`

```
iPhone: Mock glasses -> DAT VideoFrame (raw, ~30 fps) -> JPEG <=640px @ ~12 fps -> WebSocket
Laptop: server/routes/glassesRelay.ts (:8788) -> /glasses/ws, /glasses/stream.mjpg, /glasses/latest.jpg
Browser: src/input/glassesSource.ts -> canvas.captureStream(30) -> <video>.srcObject
```

Toolkit: `https://github.com/facebook/meta-wearables-dat-ios` 1.0.1 (Swift package, already set in the project).
Requirements: Xcode 26.4+ (you have 26.6), iPhone on iOS 17.2+. No Meta developer account and no Meta AI
app are needed for the Mock Device Kit: `MockDeviceKit.enable()` starts registered with permissions granted.

---

## 1. Start the laptop side

In the repo folder:

```bash
npm run dev:all          # Vite (5180) + API proxy (8787); the proxy also starts the glasses relay on 8788
ipconfig getifaddr en0   # your laptop's Wi-Fi IP, e.g. 10.18.8.2. Type it into the phone app.
```

The phone and the laptop must be on the **same Wi-Fi** (hackathon Wi-Fi often blocks device-to-device
traffic; if so, turn on your iPhone's Personal Hotspot and join it from the laptop, then rerun
`ipconfig getifaddr en0` (or `bridge100`)). If macOS asks whether `node` may accept incoming connections, click **Allow**.

Watch it: open **http://localhost:5180/glasses-debug.html** (shows the MJPEG stream, the app-side `<video>`, and fps).

## 2. Open the project

1. In Finder, open `ios/` and double-click **`GlassesRelay.xcodeproj`** (it opens in Xcode).
2. Wait for "Resolving Package Graph" in the top bar to finish. Xcode downloads the Meta toolkit (~120 MB)
   the first time. If it fails: menu **File > Packages > Reset Package Caches**.

## 3. Signing with your free Apple ID (one time)

1. Menu **Xcode > Settings... > Accounts**, click **+** (bottom left) > **Apple ID**, sign in. Close Settings.
2. In the left sidebar click the blue **GlassesRelay** project icon (the top item).
3. In the middle pane, under TARGETS, select **GlassesRelay**, then the **Signing & Capabilities** tab.
4. Tick **Automatically manage signing**. Set **Team** to "*Your Name* (Personal Team)".
5. Change **Bundle Identifier** from `com.CHANGEME.glassesrelay` to something unique, e.g.
   `com.rahulsrinivas.glassesrelay`. The red signing errors should disappear.

## 4. Install on your iPhone

1. Plug the iPhone into the Mac with a cable. Unlock it and tap **Trust** if asked.
2. Turn on Developer Mode on the iPhone: **Settings > Privacy & Security > Developer Mode > On**, restart,
   confirm. (The switch only appears after the phone has been plugged into Xcode once.)
3. In Xcode's top bar, click the device menu (next to "GlassesRelay") and pick your iPhone.
4. Press **Run** (the triangle button, or Cmd+R). The first build takes a minute or two.
5. If Xcode says the app couldn't launch because the developer isn't trusted: on the iPhone open
   **Settings > General > VPN & Device Management**, tap your Apple ID, tap **Trust**. Press Run again.

## 5. Stream

1. In the app, type the laptop IP from step 1 and tap **Start streaming**.
2. Allow **Camera** (the mock glasses use the back camera) and **Local Network** (to reach the laptop).
   If you tapped "Don't Allow": iPhone **Settings > Glasses Relay**, turn both on, then Stop/Start.
3. Expected: `Stream: streaming`, then `DAT: ~30 fps · sent: ~12 fps · connected` in green and a preview
   of what was sent. The debug page on the laptop shows the same frames.

## 6. Show the edits on the glasses (Meta Ray-Ban Display)

The Ray-Ban Display has a 600x600 see-through display in the right lens. The app can put the edits
there instead of only on the laptop screen:

```
Laptop: Stage edit -> src/edit/glassesOverlay.ts (600x600 PNG, black = see-through) -> ws /glasses/overlay
Relay: latest overlay -> the phone, over the same socket the phone sends frames on
iPhone: GlassesDisplay.swift -> DAT Display: display.send(FlexBox { Image(image:) })
```

1. Before tapping Start, turn on **Ray-Ban Display**. The mock is then a Meta Ray-Ban Display
   (`.metaRayBanDisplay`), the session also gets a `Display`, and a square preview of the mock display
   shows in the app (black there = see-through on real glasses).
2. In the web app (Source: Glasses relay), set **Display** to **Whole frame**: freeze, select and edit as
   usual. The display shows only what changed (the edited pixels), a white outline of the selection and
   the voice status. Undo and clear selection update it too; going live again leaves just the status.
3. On real glasses, use **Aligned window**: the display covers only ~20 degrees of the camera's much wider
   view, so the overlay has to be cropped to that window. Turn on **Test pattern** (a border and a center
   cross on the display), look at something with clear corners, and adjust **cx / cy / size** until the
   dashed box on the laptop stage matches what the border frames on the glasses. Saved in the browser.

Limits of this step: one image per update (each Display send replaces the screen, and travels over
Bluetooth, so expect about one update a second); the overlay only lines up while the head stays where
it was when the frame was frozen; the display adds light, so recolor reads as a tint and remove/blur
can only draw the edited pixels over the real object, which still shows through.

Laptop side without a phone: `http://localhost:8788/glasses/overlay.png` is the latest overlay.

## Try it without the iPhone (iOS Simulator)

Pick **iPhone 17 Pro** (any simulator) in the device menu, press Run, type `127.0.0.1` as the IP and tap
Start. The simulator has no camera, so the mock plays `mock-feed.mp4` (a moving test pattern).
From a terminal you can also skip the typing:

```bash
xcrun simctl launch --terminate-running-process booted com.CHANGEME.glassesrelay -laptopIP 127.0.0.1 -autostart YES
```

(use your own bundle identifier if you changed it).

## Troubleshooting

- **"not connected" (orange)**: wrong IP, laptop relay not running (`curl localhost:8788/glasses/status`),
  different Wi-Fi network, client isolation on the Wi-Fi (use the hotspot), or Local Network permission off.
- **Status stuck on "Waiting for device..."**: tap Stop, then Start again (a fresh mock device is paired each time).
- **Xcode console shows many "Class ... is implemented in both MWDATMockDevice and MWDATCamera"** lines:
  that comes from the toolkit's own binaries; it's harmless (Meta's sample app does the same).
- **"Wearables.configure failed"** then a crash: the app wasn't signed (it needs keychain access). Make sure
  a Team is selected (step 3); in the simulator, don't build with `CODE_SIGNING_ALLOWED=NO`.
- **Free Apple ID limits**: the install expires after 7 days (just press Run again), max 3 sideloaded apps.

## Files

- `GlassesRelay/RelayModel.swift`: toolkit lifecycle (mock pairing, session, camera stream)
- `GlassesRelay/FrameSender.swift`: frame -> 640px JPEG -> WebSocket, drops frames instead of lagging;
  also receives the overlays the relay sends back
- `GlassesRelay/GlassesDisplay.swift`: DAT Display capability, overlay PNG -> glasses display (latest wins)
- `GlassesRelay/ContentView.swift`, `GlassesRelayApp.swift`: UI and `Wearables.configure()`
- `GlassesRelay-Info.plist`: `MWDAT` keys (empty MetaAppID/ClientToken is fine for the mock), permissions
- `GlassesRelay/mock-feed.mp4`: HEVC test clip for the simulator (made with ffmpeg `testsrc2`)

## Moving to real glasses later

Remove the `MockDeviceKit` block in `RelayModel.start()`. For the display, real Ray-Ban Display glasses
also need the Device Access Toolkit app on the glasses (the app shows "Display needs the DAT app on the
glasses updated" if not). Real glasses additionally need: the Meta AI app with
Developer Mode on (or an app registered in the Wearables Developer Center, putting its MetaAppID/ClientToken
into the Info.plist), app registration via `Wearables.shared.startRegistration()`, and the camera permission
granted in the Meta AI app. The streaming and relay code stay the same.
