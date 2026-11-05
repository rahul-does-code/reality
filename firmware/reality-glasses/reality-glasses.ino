// Reality is yours: DIY AR glasses firmware for the Seeed Studio XIAO ESP32S3 Sense.
//
//   camera (OV2640) --JPEG over WebSocket--> laptop relay "/" (same as the phone app)
//   relay /glasses/display?raw=128&fetch=1 --scene/anchor/status JSON--> this board
//   relay GET /glasses/scene.rgb565?n=128 --> the overlay, drawn on the 128x128 OLED (beam splitter)
//   MPU-6050 gyro: moves the overlay with your head between camera frames (like the Ray-Ban web app)
//   SELECT button: press = freeze + point straight ahead + record; release = send the clip (WAV) to
//                  POST /glasses/audio, which the laptop transcribes and runs as the command
//   UNDO button:   short press = undo, hold 0.8 s = done (back to live)
//
// Board: "XIAO_ESP32S3" (esp32 Arduino core 3.x), Tools > PSRAM: "OPI PSRAM", USB CDC On Boot: Enabled.
// Libraries (Library Manager): WebSockets (Markus Sattler), ArduinoJson 7, Adafruit SSD1351, Adafruit GFX.
// Copy config.example.h to config.h and fill it in.
//
// Wiring (XIAO pin -> part):
//   D8 (GPIO7) SCK -> OLED CLK      D10 (GPIO9) MOSI -> OLED DIN     D1 (GPIO2) -> OLED CS
//   D2 (GPIO3) -> OLED DC           D3 (GPIO4) -> OLED RST           3V3/GND -> OLED VCC/GND
//   D4 (GPIO5) SDA -> MPU-6050 SDA  D5 (GPIO6) SCL -> MPU-6050 SCL   3V3/GND -> MPU-6050 VCC/GND
//   D0 (GPIO1) -> SELECT button -> GND        D6 (GPIO43) -> UNDO button -> GND
//   BAT+/BAT- pads (under the board) -> power switch -> LiPo (the XIAO charges it over USB-C)

#include <Adafruit_GFX.h>
#include <Adafruit_SSD1351.h>
#include <ArduinoJson.h>
#include <ESP_I2S.h>
#include <HTTPClient.h>
#include <SPI.h>
#include <WebSocketsClient.h>
#include <WiFi.h>
#include <Wire.h>

#include "camera_pins.h"
#include "config.h"
#include "esp_camera.h"

// ---- pins ----
constexpr int PIN_OLED_CS = D1, PIN_OLED_DC = D2, PIN_OLED_RST = D3;
constexpr int PIN_SELECT = D0, PIN_UNDO = D6;
constexpr int PIN_SD_CS = 21;           // Sense board's SD slot shares the SPI bus: keep it deselected
constexpr int PIN_MIC_CLK = 42, PIN_MIC_DATA = 41; // Sense board's PDM microphone
constexpr uint8_t MPU_ADDR = 0x68;
constexpr int N = DISPLAY_SIZE;

// ---- state ----
Adafruit_SSD1351 oled(N, N, &SPI, PIN_OLED_CS, PIN_OLED_DC, PIN_OLED_RST);
GFXcanvas16 canvas(N, N);         // what's drawn this frame (before mirroring)
uint16_t* scene = nullptr;        // the current overlay, N x N RGB565 (little-endian)
uint16_t* out = nullptr;          // mirrored copy pushed to the OLED
bool hasScene = false;
WebSocketsClient wsCam, wsDisp;
I2SClass mic;

int sceneId = 0;                  // current scene (anchors for others are ignored)
bool sceneFetch = false;          // a new scene image to fetch over HTTP
long long sceneT = -1;            // relay ms when its frame was captured, -1 = static (no head motion)
bool hasAnchor = false;
float anchorDx = 0, anchorDy = 0; // display px (already scaled from the 600 px scene)
long long anchorT = 0;            // relay ms of the tracker's frame
String status;
double clockOffset = 0;           // relay ms - millis(), from the ping with the shortest round trip
uint32_t bestRtt = UINT32_MAX;

// gyro: integrated yaw (left +) and pitch (up +), degrees, with a short history for look-ups
struct Pose { uint32_t ms; float yaw, pitch; };
constexpr int HIST = 512;         // ~5 s at 100 Hz
Pose hist[HIST];
int histHead = 0, histCount = 0;
float yaw = 0, pitch = 0, gyroBias[3] = {0, 0, 0};
bool imuOk = false;
uint32_t lastImuUs = 0;

// push-to-talk
int16_t* talkBuf = nullptr;
size_t talkLen = 0;                // samples recorded
bool talking = false;
uint32_t talkStart = 0;

// ---------------------------------------------------------------- MPU-6050
void mpuWrite(uint8_t reg, uint8_t v) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(v);
  Wire.endTransmission();
}

bool mpuReadGyro(float dps[3]) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x43); // GYRO_XOUT_H
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(MPU_ADDR, (uint8_t)6) != 6) return false;
  for (int i = 0; i < 3; i++) {
    int16_t raw = (Wire.read() << 8) | Wire.read();
    dps[i] = raw / 131.0f; // +-250 dps full scale
  }
  return true;
}

void imuBegin() {
  Wire.begin(D4, D5, 400000);
  mpuWrite(0x6B, 0x00); // wake
  mpuWrite(0x1A, 0x03); // DLPF ~44 Hz
  mpuWrite(0x1B, 0x00); // +-250 dps
  delay(50);
  float g[3], sum[3] = {0, 0, 0};
  int ok = 0;
  for (int i = 0; i < 200; i++) { // keep still: average the bias
    if (mpuReadGyro(g)) { for (int k = 0; k < 3; k++) sum[k] += g[k]; ok++; }
    delay(3);
  }
  imuOk = ok > 100;
  for (int k = 0; k < 3; k++) gyroBias[k] = ok ? sum[k] / ok : 0;
  Serial.printf("[imu] %s, bias %.2f %.2f %.2f dps\n", imuOk ? "ok" : "NOT FOUND", gyroBias[0], gyroBias[1], gyroBias[2]);
}

void imuUpdate() {
  if (!imuOk) return;
  uint32_t now = micros();
  if (now - lastImuUs < 5000) return; // ~200 Hz
  float g[3];
  if (!mpuReadGyro(g)) return;
  float dt = lastImuUs ? (now - lastImuUs) / 1e6f : 0;
  lastImuUs = now;
  if (dt > 0.1f) dt = 0.1f;
  yaw += YAW_SIGN * (g[YAW_AXIS] - gyroBias[YAW_AXIS]) * dt;
  pitch += PITCH_SIGN * (g[PITCH_AXIS] - gyroBias[PITCH_AXIS]) * dt;
  static uint32_t lastHistMs = 0;
  uint32_t ms = millis();
  if (ms - lastHistMs >= 10) {
    lastHistMs = ms;
    hist[histHead] = {ms, yaw, pitch};
    histHead = (histHead + 1) % HIST;
    if (histCount < HIST) histCount++;
  }
}

// Pose at local time ms: the last sample at or before it (or the oldest one).
Pose poseAt(uint32_t ms) {
  Pose best = {ms, yaw, pitch};
  for (int i = 1; i <= histCount; i++) {
    const Pose& p = hist[(histHead - i + HIST) % HIST];
    best = p;
    if ((int32_t)(ms - p.ms) >= 0) break;
  }
  return best;
}

// ---------------------------------------------------------------- camera
bool cameraBegin() {
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer = LEDC_TIMER_0;
  c.pin_d0 = Y2_GPIO_NUM; c.pin_d1 = Y3_GPIO_NUM; c.pin_d2 = Y4_GPIO_NUM; c.pin_d3 = Y5_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM; c.pin_d5 = Y7_GPIO_NUM; c.pin_d6 = Y8_GPIO_NUM; c.pin_d7 = Y9_GPIO_NUM;
  c.pin_xclk = XCLK_GPIO_NUM; c.pin_pclk = PCLK_GPIO_NUM; c.pin_vsync = VSYNC_GPIO_NUM; c.pin_href = HREF_GPIO_NUM;
  c.pin_sccb_sda = SIOD_GPIO_NUM; c.pin_sccb_scl = SIOC_GPIO_NUM;
  c.sccb_i2c_port = 1; // Wire (the gyro) uses port 0
  c.pin_pwdn = PWDN_GPIO_NUM; c.pin_reset = RESET_GPIO_NUM;
  c.xclk_freq_hz = 20000000;
  c.pixel_format = PIXFORMAT_JPEG;
  c.frame_size = CAMERA_FRAME_SIZE;
  c.jpeg_quality = CAMERA_JPEG_QUALITY;
  c.fb_count = 2;
  c.fb_location = CAMERA_FB_IN_PSRAM;
  c.grab_mode = CAMERA_GRAB_LATEST; // never send a stale frame
  esp_err_t err = esp_camera_init(&c);
  Serial.printf("[cam] init %s\n", err == ESP_OK ? "ok" : esp_err_to_name(err));
  return err == ESP_OK;
}

void cameraSend() {
  static uint32_t last = 0, sentThisSec = 0, secStart = 0, fps = 0;
  uint32_t now = millis();
  if (now - last < 1000 / CAMERA_FPS || !wsCam.isConnected()) return;
  last = now;
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) return;
  char meta[24];
  snprintf(meta, sizeof meta, "{\"fps\":%lu}", (unsigned long)fps);
  wsCam.sendTXT(meta);
  wsCam.sendBIN(fb->buf, fb->len);
  esp_camera_fb_return(fb);
  sentThisSec++;
  if (now - secStart >= 1000) { fps = sentThisSec; sentThisSec = 0; secStart = now; }
}

// ---------------------------------------------------------------- relay messages
void onDisplayMessage(uint8_t* data, size_t len) {
  JsonDocument m;
  if (deserializeJson(m, data, len)) return;
  const char* type = m["type"] | "";
  if (!strcmp(type, "scene")) {
    sceneId = m["id"] | 0;
    sceneT = m["t"].isNull() ? -1 : (long long)m["t"].as<double>();
    hasAnchor = false;
    if (m["image"] | false) sceneFetch = true;
    else hasScene = false;
  } else if (!strcmp(type, "anchor")) {
    if ((m["id"] | -1) != sceneId) return;
    anchorDx = (m["dx"] | 0.0f) * N / 600.0f;
    anchorDy = (m["dy"] | 0.0f) * N / 600.0f;
    anchorT = (long long)(m["t"] | 0.0);
    hasAnchor = true;
  } else if (!strcmp(type, "status")) {
    status = "";
    for (const char* p = m["text"] | ""; *p; p++) status += (*p >= 32 && *p < 127) ? *p : '\''; // ASCII font
  } else if (!strcmp(type, "pong")) {
    uint32_t now = millis();
    uint32_t sent = m["t"].as<uint32_t>();
    uint32_t rtt = now - sent;
    if (rtt <= bestRtt) {
      bestRtt = rtt;
      clockOffset = (m["server"] | 0.0) - (sent + now) / 2.0;
    }
  }
}

void wsDispEvent(WStype_t type, uint8_t* payload, size_t len) {
  if (type == WStype_TEXT) onDisplayMessage(payload, len);
  else if (type == WStype_CONNECTED) { Serial.println("[relay] display connected"); bestRtt = UINT32_MAX; }
  else if (type == WStype_DISCONNECTED) Serial.println("[relay] display disconnected");
}

void wsCamEvent(WStype_t type, uint8_t*, size_t) {
  if (type == WStype_CONNECTED) Serial.println("[relay] camera connected");
  else if (type == WStype_DISCONNECTED) Serial.println("[relay] camera disconnected");
}

void sendInput(const char* action) {
  char msg[48];
  snprintf(msg, sizeof msg, "{\"type\":\"input\",\"action\":\"%s\"}", action);
  wsDisp.sendTXT(msg);
}

void pingRelay() {
  static uint32_t last = 0;
  if (millis() - last < 2000 || !wsDisp.isConnected()) return;
  last = millis();
  char msg[48];
  snprintf(msg, sizeof msg, "{\"type\":\"ping\",\"t\":%lu}", (unsigned long)millis());
  wsDisp.sendTXT(msg);
}

void fetchScene() {
  if (!sceneFetch) return;
  sceneFetch = false;
  HTTPClient http;
  char url[96];
  snprintf(url, sizeof url, "http://%s:%d/glasses/scene.rgb565?n=%d", RELAY_HOST, RELAY_PORT, N);
  http.begin(url);
  int code = http.GET();
  if (code == 200 && http.getSize() == N * N * 2) {
    WiFiClient* s = http.getStreamPtr();
    size_t got = 0, want = N * N * 2;
    uint32_t t0 = millis();
    while (got < want && millis() - t0 < 2000) {
      int n = s->readBytes((uint8_t*)scene + got, want - got);
      if (n > 0) got += n;
    }
    hasScene = got == want;
  } else {
    hasScene = false;
  }
  http.end();
}

// ---------------------------------------------------------------- voice
void talkStartRecording() {
  talking = true;
  talkLen = 0;
  talkStart = millis();
}

void talkRecord() {
  if (!talking) return;
  const size_t maxSamples = 16000 * MAX_TALK_MS / 1000;
  size_t want = min((size_t)512, maxSamples - talkLen);
  if (!want) return;
  size_t n = mic.readBytes((char*)(talkBuf + talkLen), want * 2);
  talkLen += n / 2;
}

void talkSend() {
  talking = false;
  if (talkLen < 16000 / 4) return; // under 0.25 s: a tap, not speech
  // WAV header in front of the samples (the buffer keeps 44 bytes free before talkBuf)
  uint8_t* wav = (uint8_t*)talkBuf - 44;
  uint32_t dataLen = talkLen * 2;
  auto u32 = [&](int o, uint32_t v) { memcpy(wav + o, &v, 4); };
  auto u16 = [&](int o, uint16_t v) { memcpy(wav + o, &v, 2); };
  memcpy(wav, "RIFF", 4); u32(4, 36 + dataLen); memcpy(wav + 8, "WAVEfmt ", 8);
  u32(16, 16); u16(20, 1); u16(22, 1); u32(24, 16000); u32(28, 32000); u16(32, 2); u16(34, 16);
  memcpy(wav + 36, "data", 4); u32(40, dataLen);
  HTTPClient http;
  char url[80];
  snprintf(url, sizeof url, "http://%s:%d/glasses/audio", RELAY_HOST, RELAY_PORT);
  http.begin(url);
  http.addHeader("Content-Type", "audio/wav");
  int code = http.POST(wav, 44 + dataLen);
  Serial.printf("[voice] %.1f s clip -> %d\n", talkLen / 16000.0f, code);
  http.end();
}

// ---------------------------------------------------------------- buttons
void buttons() {
  static bool selDown = false, undoDown = false;
  static uint32_t selChange = 0, undoChange = 0, undoPressed = 0;
  uint32_t now = millis();
  bool sel = digitalRead(PIN_SELECT) == LOW;
  if (sel != selDown && now - selChange > 30) { // debounced edge
    selDown = sel;
    selChange = now;
    if (sel) { sendInput("select"); talkStartRecording(); }
    else if (talking) talkSend();
  }
  if (talking && now - talkStart > MAX_TALK_MS) talkSend();
  bool undo = digitalRead(PIN_UNDO) == LOW;
  if (undo != undoDown && now - undoChange > 30) {
    undoDown = undo;
    undoChange = now;
    if (undo) undoPressed = now;
    else sendInput(now - undoPressed >= 800 ? "done" : "undo");
  }
}

// ---------------------------------------------------------------- drawing
void draw() {
  static uint32_t last = 0;
  uint32_t now = millis();
  if (now - last < 33) return; // ~30 fps
  last = now;
  canvas.fillScreen(0);
  if (hasScene) {
    float dx = 0, dy = 0;
    long long baseRelay = hasAnchor ? anchorT : sceneT;
    if (baseRelay >= 0 && bestRtt != UINT32_MAX) { // needs the relay clock (first pong) to look up the pose
      // head motion since the base frame was captured (relay clock -> local millis)
      uint32_t baseLocal = (uint32_t)(baseRelay - clockOffset - LAG_MS);
      Pose b = poseAt(baseLocal);
      dx = (hasAnchor ? anchorDx : 0) + (yaw - b.yaw) * PX_PER_DEG;   // turn left -> world moves right
      dy = (hasAnchor ? anchorDy : 0) + (pitch - b.pitch) * PX_PER_DEG; // look up -> world moves down
    }
    int ox = lroundf(dx), oy = lroundf(dy);
    uint16_t* dst = canvas.getBuffer();
    for (int y = 0; y < N; y++) {
      int sy = y - oy;
      if (sy < 0 || sy >= N) continue;
      for (int x = 0; x < N; x++) {
        int sx = x - ox;
        if (sx >= 0 && sx < N) dst[y * N + x] = scene[sy * N + sx];
      }
    }
  }
  if (status.length()) {
    canvas.fillRect(0, N - 11, N, 11, 0x18E3); // dark gray strip: black would be invisible
    canvas.setTextColor(0xFFFF);
    canvas.setTextSize(1);
    canvas.setCursor(2, N - 9);
    canvas.print(status.substring(0, N / 6));
  }
  if (talking) canvas.fillCircle(N - 6, 6, 3, 0xF800); // recording dot
  // mirror for the beam splitter, then push
  const uint16_t* src = canvas.getBuffer();
  for (int y = 0; y < N; y++)
    for (int x = 0; x < N; x++)
      out[y * N + x] = src[(MIRROR_Y ? N - 1 - y : y) * N + (MIRROR_X ? N - 1 - x : x)];
  oled.startWrite();
  oled.setAddrWindow(0, 0, N, N);
  oled.writePixels(out, N * N, true, false);
  oled.endWrite();
}

// ---------------------------------------------------------------- setup / loop
void setup() {
  Serial.begin(115200);
  pinMode(PIN_SD_CS, OUTPUT);
  digitalWrite(PIN_SD_CS, HIGH);
  pinMode(PIN_SELECT, INPUT_PULLUP);
  pinMode(PIN_UNDO, INPUT_PULLUP);

  scene = (uint16_t*)ps_malloc(N * N * 2);
  out = (uint16_t*)ps_malloc(N * N * 2);
  uint8_t* talkMem = (uint8_t*)ps_malloc(44 + 16000 * 2 * MAX_TALK_MS / 1000 + 1024);
  talkBuf = (int16_t*)(talkMem + 44);
  if (!scene || !out || !talkMem) Serial.println("[mem] PSRAM allocation failed: Tools > PSRAM must be OPI PSRAM");

  SPI.begin(D8, D9, D10);
  oled.begin(16000000);
  oled.fillScreen(0);
  oled.setTextColor(0xFFFF);
  oled.setCursor(2, 2);
  oled.print("Reality is yours");
  oled.setCursor(2, 14);
  oled.print("keep still...");

  imuBegin();
  // Axis finder: hold UNDO while powering on, then turn left / look up and watch the serial monitor.
  if (digitalRead(PIN_UNDO) == LOW) {
    while (true) {
      float g[3];
      if (mpuReadGyro(g)) Serial.printf("gyro x %+7.1f  y %+7.1f  z %+7.1f dps\n", g[0] - gyroBias[0], g[1] - gyroBias[1], g[2] - gyroBias[2]);
      delay(100);
    }
  }
  cameraBegin();
  mic.setPinsPdmRx(PIN_MIC_CLK, PIN_MIC_DATA);
  if (!mic.begin(I2S_MODE_PDM_RX, 16000, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO)) Serial.println("[mic] init failed");

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  oled.setCursor(2, 26);
  oled.print("wifi...");
  while (WiFi.status() != WL_CONNECTED) delay(200);
  Serial.printf("[wifi] %s\n", WiFi.localIP().toString().c_str());

  wsCam.begin(RELAY_HOST, RELAY_PORT, "/");
  wsCam.onEvent(wsCamEvent);
  wsCam.setReconnectInterval(1000);
  char path[48];
  snprintf(path, sizeof path, "/glasses/display?raw=%d&fetch=1", N);
  wsDisp.begin(RELAY_HOST, RELAY_PORT, path);
  wsDisp.onEvent(wsDispEvent);
  wsDisp.setReconnectInterval(1000);
}

void loop() {
  wsCam.loop();
  wsDisp.loop();
  imuUpdate();
  buttons();
  talkRecord();
  if (!talking) cameraSend(); // the mic gets the loop while you talk
  fetchScene();
  pingRelay();
  draw();
}
