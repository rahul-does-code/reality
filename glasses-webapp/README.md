# Glasses web app (Meta Ray-Ban Display)

Runs on the glasses themselves and draws the laptop's edit overlay **on the object**, moving it with
your head. Step 1 (the phone app's "Ray-Ban Display" toggle) pushes a still image through the phone
about once a second and only lines up while you hold still. This app fixes that:

```
laptop Stage --(scene: overlay PNG + capture time, status, tracker anchors)--> relay :8788
relay /glasses/display --wss--> this app on the glasses --> 600x600 canvas, redrawn every frame
                                 + glasses gyro: shift/roll by the head motion since capture
```

- **Head motion:** the glasses' gyro (`devicemotion`, falling back to `deviceorientation`) is kept as a
  4 s history. Each frame, the overlay moves by the head rotation since its camera frame was
  captured: turning left moves it right by `ppd` px per degree, looking up moves it down, tilting
  rotates it.
- **Re-anchoring:** while frozen, the laptop finds the object in the live glasses video five times a
  second (`src/vision/track.ts`) and sends where it is ("anchor"). The app then uses that position plus
  only the head motion after it, which removes gyro drift and covers walking around.
- **Clocks:** the app pings the relay every 2 s and keeps the offset from the fastest round trip, so
  the laptop's frame times can be looked up in the glasses' pose history.

## Run it

1. `npm run build` (also builds this app into `glasses-webapp/dist`; `npm run build:glasses` for just
   this), then `npm run dev`. The relay serves the app at `http://localhost:8788/glasses/app/`.
2. The glasses only load web apps from a public **HTTPS** URL. Tunnel the relay port, for example:
   ```bash
   cloudflared tunnel --url http://localhost:8788
   ```
   Note the `https://<name>.trycloudflare.com` it prints. The app connects back to the same host
   (`wss://<name>.trycloudflare.com/glasses/display`), so one tunnel covers both.
3. In the **Meta AI app**: Devices > Display Glasses settings > App connections > Web apps >
   Add a web app, name it, and enter `https://<name>.trycloudflare.com/glasses/app/`.
4. Keep the phone relay app streaming the camera (`ios/`). Leave its "Ray-Ban Display" toggle **off**:
   this app draws the display instead.
5. In the laptop web app: Source = Glasses relay, Display = Aligned window (see below).
6. On the glasses, open the app and pinch **Start**. Pinch **Info** for a readout (connection, fps,
   head sensor rate, clock offset, current shift). The buttons fade after 6 s; swipe or pinch once to
   bring them back (that first input only wakes them).

## Calibrate

- **Head axes** (once per glasses): pinch **Calibrate**, then turn your head left when asked, then look
  up. It learns which sensor axes those are; saved on the glasses.
- **Window** (laptop): the display covers ~20 degrees of the much wider camera view. Turn on **Test
  pattern** and adjust cx / cy / size until the dashed box on the laptop matches what the border on the
  glasses frames.
- **URL parameters** (add to the web app URL): `ppd` = display px per degree of head turn (default 30, i.e.
  600 px over 20 degrees; raise it if the overlay lags behind turns, lower it if it overshoots), `lag` =
  ms between the camera capture and the frame reaching the relay (default 150), `relay` = a different
  socket URL (for `npx vite --config glasses-webapp/vite.config.ts` on :5182, use
  `?relay=ws://localhost:8788/glasses/display`).

## Test

`npm run build:glasses && npm run test:glasses`: headless Chromium against a real relay, standing in
for the laptop and the gyro. It checks turn/look-up/tilt directions, anchors, status, calibration
and clear.

## Limits

Still an additive display in one eye: the overlay adds light over the real object (recolor reads as
a tint; remove/blur can't hide what's there). The tracker follows the object's position, not its
size or rotation, and loses it if it changes a lot or leaves the camera view.
