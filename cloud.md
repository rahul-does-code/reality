# Cloud session handoff: AR glasses work

Branch `claude/upbeat-noether-h3ehap`, based on `main` at `e8b07ce` (the post-hackathon revert).
`main` is untouched. Nothing here has run on a phone, glasses or ESP32; see "Left undone".

## 1. What was scoped (in order)

1. "Figure out how to integrate AR into the glasses directly so the user sees the changes, not the
   livestream." Research only. Findings:
   - **Ray-Ban Display:** has a see-through (additive), one-eye, 600x600 display. Third-party apps
     can draw on it through the Wearables Device Access Toolkit (DAT) 0.7+ (this repo pins 1.0.1)
     or through a glasses web app.
   - **Quest 3 (passthrough camera):** the only route where remove/blur truly hide objects.
   - **Plan:** step 1 = still overlays through the phone, step 2 = a glasses web app with head-gyro
     compensation, step 3 = hands-free control.
2. "Go for it": step 1.
3. "Start step 2."
4. "Next what" → "start step 3".
5. "I don't have Rays, how would I build a lens…" Proposed a phone visor (stage 1) or DIY glasses
   (stage 2).
6. "DIY glasses, 3D print almost everything (free printing at UT)."
7. Manager session: autonomy rules, then this handoff file.

## 2. What was done

| Step | Commits | Result |
|---|---|---|
| 1. Ray-Ban Display stills | `25e5b7c`, `89c8775` | Laptop renders the edit as a 600x600 PNG (black = see-through, white selection outline, status strip). It is relayed back to the iOS app, which shows it with DAT `Display` (`Image(image:)`). Mock display preview on the phone. |
| 2. Glasses web app | `529a7ce`, `94891dc` | `glasses-webapp/` runs on the Display glasses. It redraws every frame and shifts/rolls the overlay by the gyro's head rotation since frame capture (clock-synced to the relay). It re-anchors on the laptop's object tracker (`src/vision/track.ts`, NCC on the frozen object, 5 Hz). It has a Calibrate step for head axes. |
| 3. Hands-free | `b1909c3`, `e02419a` | Web app buttons Select/Undo/Done (pinch). Select freezes, points ahead or at the fingertip, and listens 10 s. The iOS app's "Glasses mic" toggle (DAT `Speech`) sends transcripts; the mock offers phone-mic ASR or a typed "Say". Laptop has an "Always listen" option. |
| 6a. Printable parts | `f07ceab` | Parametric OpenSCAD in `hardware/glasses/scad/` and 10 STLs in `hardware/glasses/stl/`, laid out for support-free printing. Parts: frame, 2 temples (left has the battery pod), lens/beam-splitter housing, display box + electronics pod, carrier, lens ring, light shield, end cap, battery lid. |
| 6b. Relay/laptop for DIY | `58d17a1` | Relay serves the scene as raw N×N RGB565 (pngjs decode + box downscale) and forwards push-to-talk WAVs to the laptop. The laptop transcribes them via `/api/transcribe` and runs the command. |
| 6c. Firmware | `2a19e3f` | `firmware/reality-glasses/` for the XIAO ESP32S3 Sense: camera to relay, 128x128 SSD1351 OLED (mirrored), MPU-6050 gyro shift, SELECT = select + push-to-talk, UNDO = undo / hold for done. Relay gained HTTP paths because the ESP32 WebSocket library caps messages at ~15 KB. |
| 6d. Build guide | `93d8d21` | `hardware/glasses/README.md`: parts (~$50-70), print, wire, assemble, flash, calibrate. |

## 3. What changed

**Added**
- `src/edit/glassesOverlay.ts`: overlay render + sink (scene/status/anchor messages).
- `src/vision/track.ts`: object tracker.
- `src/input/glassesEvents.ts`: transcripts, buttons and audio from the glasses.
- `glasses-webapp/` (`index.html`, `src/main.ts`, `src/headPose.ts`, `vite.config.ts`, `README.md`).
- `ios/GlassesRelay/GlassesDisplay.swift`, `ios/GlassesRelay/GlassesSpeech.swift`.
- `hardware/glasses/` (`scad/`, `stl/`, `images/`, `export.sh`, `README.md`).
- `firmware/reality-glasses/` (`reality-glasses.ino`, `config.example.h`, `camera_pins.h`).
- Tests: `scripts/test-glasses-webapp.mjs`, `scripts/test-glasses-diy.mjs`.

**Modified**
- `server/routes/glassesRelay.ts`:
  - **Overlay and glasses web app:** `/glasses/overlay` in, `/glasses/display` (app socket, clock-sync pings), and `/glasses/app/` (serves the built web app).
  - **Hands-free:** `/glasses/events` to the laptop.
  - **DIY glasses:** `?raw=N&fetch=1` raw-frame mode, `GET /glasses/scene.rgb565`, `POST /glasses/audio`, and `GET /glasses/overlay.png`.
- `src/ui/Stage.tsx`: Display dropdown (Off / Whole frame / Aligned window with cx, cy, size), Test pattern, tracker, Always listen, glasses event handling.
- `src/input/glassesSource.ts`: exports `glassesFrameTimes()`.
- `src/styles.css`.
- `ios/GlassesRelay/{RelayModel,FrameSender,ContentView}.swift`.
- `ios/GlassesRelay.xcodeproj/project.pbxproj`: adds the MWDATDisplay and MWDATSpeech products, plus mic and speech usage strings.
- `ios/GlassesRelay-Info.plist`: background modes and the `com.meta.ar.wearable` accessory protocol.
- `package.json`:
  - `build` now also runs `build:glasses`;
  - new scripts `test:glasses` and `test:diy`;
  - dependency `pngjs`, dev dependencies `playwright@1.63.0` and `@types/pngjs`.
- `tsconfig.json`: includes `glasses-webapp/src`.
- `.gitignore`: ignores `firmware/**/config.h`.
- `README.md`, `ios/README.md`.

**Config:** no new env vars. Voice transcription needs the existing `META_API_KEY`. The firmware needs `firmware/reality-glasses/config.h`, copied from `config.example.h`: Wi-Fi, laptop IP, mirroring, `PX_PER_DEG`, `LAG_MS`, gyro axes. Web app URL params: `ppd`, `lag`, `relay`.

## 4. Left undone or unverified

- **iOS app never compiled.** No Xcode here. The Swift was checked by hand against the DAT 1.0.1
  `.swiftinterface` files.
- **ESP32 firmware never compiled.** Downloading the toolchain was blocked here. It was written
  against esp32 core 3.x, WebSockets (links2004) 2.x, ArduinoJson 7 and Adafruit SSD1351/GFX.
  `c.sccb_i2c_port` may not exist in older esp32-camera versions.
- **No hardware testing:** no Ray-Ban Display, no ESP32, no printed parts.
- **Guessed defaults to tune:** web app `ppd`=30 and `lag`=150; firmware `PX_PER_DEG`=4.3 and
  `LAG_MS`=150; gyro axes.
- **`MEASURE` params** in `hardware/glasses/scad/params.scad`: ipd, head width, temple length,
  OLED board (assumed 44.5x37 mm, 27 mm visible area), lens (25 mm / f45), splitter, battery, XIAO
  stack height. Then rerun `export.sh`.
- **Not test-printed;** fit clearance `clear`=0.3 is a guess. Optics (focus range, brightness) unproven.
- **Unconfirmed on real hardware:**
  - DAT `Speech`/`Inputs` are experimental.
  - Glasses web apps reaching a `wss://` tunnel is unconfirmed.
  - The `deviceorientation`/`devicemotion` axes on the glasses are unknown; Calibrate covers that.
- **Commands not run end to end:** commands ran only against a stand-in API (no keys here), so
  Gemini/Muse were never hit.
- **No PR opened.** Merging is Rahul's call (hackathon-rules revert on `main`).

## 5. Pick up locally

```bash
git fetch origin claude/upbeat-noether-h3ehap && git checkout claude/upbeat-noether-h3ehap
```

```bash
npm install && node scripts/setup.mjs
```

```bash
npm run build && npm run test:glasses && npm run test:diy
```

```bash
npm run dev
```

- **iOS:** open `ios/GlassesRelay.xcodeproj`, let the package resolve, set Team and bundle ID, build.
  Turn on "Ray-Ban Display" and "Glasses mic"; the mock display preview and the typed "Say" field
  test without glasses. Fix compile errors first; likely spots are DAT typed throws and SwiftUI/DAT
  name clashes (Display code is kept in non-SwiftUI files).
- **ESP32 (CLI):** these commands are untested.
  ```bash
  brew install arduino-cli
  ```
  ```bash
  arduino-cli config add board_manager.additional_urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
  ```
  ```bash
  arduino-cli core update-index && arduino-cli core install esp32:esp32
  ```
  ```bash
  arduino-cli lib install WebSockets ArduinoJson "Adafruit SSD1351 library" "Adafruit GFX Library"
  ```
  ```bash
  cp firmware/reality-glasses/config.example.h firmware/reality-glasses/config.h
  ```
  ```bash
  arduino-cli compile --fqbn esp32:esp32:XIAO_ESP32S3:PSRAM=opi firmware/reality-glasses
  ```
  Compile before buying parts. The IDE route is in `hardware/glasses/README.md`.
- **Printing:** edit the `MEASURE` lines, `cd hardware/glasses && ./export.sh`, test-print
  `lens_housing.stl` first.
- **Risks to check first, in order:**
  1. The iOS and firmware compile.
  2. The OLED module's real size against `disp_pcb_w`/`disp_pcb_h`.
  3. Image mirroring through the splitter (`MIRROR_X`).
  4. Gyro axis signs.
  5. Whether campus Wi-Fi allows device-to-laptop traffic; use the phone hotspot if not.
