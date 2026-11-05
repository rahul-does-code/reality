// Copy this file to config.h (which git ignores) and fill it in.
#pragma once

// ---- network: the laptop running `npm run dev` (the glasses relay is on port 8788) ----
#define WIFI_SSID "your-wifi"
#define WIFI_PASS "your-password"
#define RELAY_HOST "192.168.1.20"   // the laptop's IP (ipconfig getifaddr en0)
#define RELAY_PORT 8788

// ---- camera ----
#define CAMERA_FRAME_SIZE FRAMESIZE_QVGA  // 320x240: keeps each JPEG well under the WebSocket limit
#define CAMERA_JPEG_QUALITY 12            // 0-63, lower = better
#define CAMERA_FPS 10

// ---- display: 1.5" 128x128 SSD1351 OLED, seen through one mirror (the beam splitter) ----
#define DISPLAY_SIZE 128
#define MIRROR_X 1          // the splitter flips the picture left-right; set 0 if text reads backwards
#define MIRROR_Y 0
// Display px the picture moves per degree of head turn: DISPLAY_SIZE / the display's field of view
// in degrees (~30 with the 45 mm lens). Raise it if the overlay lags behind your head turns,
// lower it if it overshoots.
#define PX_PER_DEG 4.3f
// ms between the camera taking a frame and it reaching the laptop (shows in the laptop's glasses
// debug page as latency). Used to look up where your head was when the frame was taken.
#define LAG_MS 150

// ---- head motion (MPU-6050 gyro): which gyro axis is "turn your head left" and "look up" ----
// 0 = x, 1 = y, 2 = z; sign 1 or -1. Hold the button combo at boot (see README) and the serial
// monitor prints which axis moves as you turn left and look up.
#define YAW_AXIS 2
#define YAW_SIGN 1
#define PITCH_AXIS 0
#define PITCH_SIGN 1

// ---- voice ----
#define MAX_TALK_MS 8000    // longest push-to-talk clip
