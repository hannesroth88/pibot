// Octobot ESP32 motor driver
// DRV8833 wiring: GPIO 4 = AIN1, GPIO 5 = AIN2
// HTTP API (POST /motor):  {"command":"forward"|"turn_left"|"stop","durationMs":N}
// Power: DRV8833 VM and ESP32 3.3V both from battery (4xAA ~6V via regulator for ESP32).
//        Add 100uF across VM/GND near DRV8833 for motor inrush.
//
// WiFi setup: on first boot (or after holding BOOT/GPIO-0 for 3 s) the ESP32 creates
// an access point called "PiBot-Setup". Connect to it from any phone or laptop, open
// http://192.168.4.1, enter your WiFi SSID and password. Credentials are saved in
// flash (NVS) and reused on every subsequent boot. Nothing is hardcoded or in git.

#include <Arduino.h>
#include <WiFiManager.h>
#include <WebServer.h>
#include <ArduinoJson.h>

// HTTP port the pibot server calls; set ESP32_URL=http://<ip>:80 in the server env.
#define HTTP_PORT 80

// Hold the BOOT button (GPIO 0, built-in on most ESP32 devkits) for RESET_HOLD_MS at
// startup to wipe saved WiFi credentials and re-enter config-AP mode.
#define RESET_PIN     0
#define RESET_HOLD_MS 3000

// DRV8833 motor inputs.
// Swap AIN1_PIN/AIN2_PIN if forward and turn are physically reversed.
#define AIN1_PIN 4   // GPIO 4 = DRV8833 AIN1
#define AIN2_PIN 5   // GPIO 5 = DRV8833 AIN2

WebServer server(HTTP_PORT);

static unsigned long motorStopAtMs = 0;
static bool motorRunning = false;

static void stopMotor() {
  digitalWrite(AIN1_PIN, LOW);
  digitalWrite(AIN2_PIN, LOW);
  motorRunning = false;
}

static void handleMotorPost() {
  if (server.method() != HTTP_POST) {
    server.send(405, "text/plain", "POST required");
    return;
  }

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, server.arg("plain"));
  if (err) {
    server.send(400, "text/plain", "bad JSON");
    return;
  }

  const char* command    = doc["command"]   | "stop";
  uint32_t    durationMs = doc["durationMs"] | 0;

  Serial.printf("motor cmd=%s durationMs=%u\n", command, durationMs);

  stopMotor();

  if (strcmp(command, "forward") == 0) {
    Serial.println("  AIN1=LOW AIN2=HIGH (forward)");
    digitalWrite(AIN1_PIN, LOW);
    digitalWrite(AIN2_PIN, HIGH);
  } else if (strcmp(command, "turn_left") == 0) {
    Serial.println("  AIN1=HIGH AIN2=LOW (turn_left)");
    digitalWrite(AIN1_PIN, HIGH);
    digitalWrite(AIN2_PIN, LOW);
  } else {
    Serial.println("  stop");
  }

  if (durationMs > 0 && strcmp(command, "stop") != 0) {
    motorStopAtMs = millis() + durationMs;
    motorRunning = true;
  }

  // Respond immediately — the server waits durationMs on its side.
  server.send(200, "application/json", "{\"ok\":true}");
}

static void handleHealth() {
  server.send(200, "text/plain", "ok");
}

void setup() {
  Serial.begin(115200);

  pinMode(RESET_PIN, INPUT_PULLUP);
  pinMode(AIN1_PIN, OUTPUT);
  pinMode(AIN2_PIN, OUTPUT);
  stopMotor();

  if (digitalRead(RESET_PIN) == LOW) {
    Serial.println("BOOT held - waiting to confirm WiFi reset...");
    delay(RESET_HOLD_MS);
    if (digitalRead(RESET_PIN) == LOW) {
      WiFiManager wm;
      wm.resetSettings();
      Serial.println("WiFi credentials cleared. Release button to continue.");
      while (digitalRead(RESET_PIN) == LOW) delay(100);
    }
  }

  WiFiManager wm;
  wm.setConfigPortalTimeout(180);
  if (!wm.autoConnect("PiBot-Setup")) {
    Serial.println("WiFiManager timed out, rebooting");
    ESP.restart();
  }

  Serial.printf("WiFi connected. IP: %s\n", WiFi.localIP().toString().c_str());

  server.on("/motor",  HTTP_POST, handleMotorPost);
  server.on("/health", HTTP_GET,  handleHealth);
  server.begin();
  Serial.printf("HTTP server on port %d\n", HTTP_PORT);
}

void loop() {
  server.handleClient();
  if (motorRunning && millis() >= motorStopAtMs) {
    stopMotor();
  }
}
