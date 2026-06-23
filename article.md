# Hardware build log

## Background: Octobot PCB

The Octobot (Silverlit) runs on a single-layer PCB with three subsystems:

- **Brain IC** (center): handles IR remote, LED effects, and motor direction.
- **IR receiver** (right): receives commands from the toy remote.
- **H-bridge** (small black IC, bottom): drives the motor from the brain's direction signals.

There is only one brushed DC motor. The gearbox has two gear paths: reversing the motor direction
engages a different set of gears, so one direction walks and the other turns the head/platform.
This means the robot can only walk forward and turn in one direction (counter-clockwise).

## Decision: keep old PCB for sound / light / IR, replace motor path

### Why not parallel the old H-bridge with DRV8833

Two H-bridges driving the same motor simultaneously is a short-circuit hazard. If one drives
forward while the other drives reverse (or into brake mode), the outputs fight each other and can
destroy one or both drivers. Do not connect both H-bridge outputs to the motor at the same time.

### Chosen approach

1. Keep the original PCB powered — IR remote, music, and LEDs continue to work.
2. Disconnect the two motor wires from the original H-bridge outputs (cut traces or unsolder).
3. Connect the motor wires to DRV8833 AOUT1 / AOUT2 instead.
4. ESP32 drives AIN1 / AIN2 on the DRV8833.

The old "brain IC" can stay. It will try to drive its own H-bridge outputs, but those are now
floating (disconnected from the motor), so it causes no harm.

## Wiring

| Signal   | ESP32-S3 GPIO | DRV8833 pin |
|----------|--------------|-------------|
| AIN1     | GPIO 4       | AIN1        |
| AIN2     | GPIO 5       | AIN2        |
| Motor +  | —         | AOUT1       |
| Motor −  | —         | AOUT2       |
| VM       | Battery + | VM          |
| GND      | Battery − | GND (shared with ESP32 GND) |

Add a 100 µF electrolytic cap across VM / GND close to the DRV8833 for motor inrush protection
(same role as the caps on the original PCB).

### Motor direction

DRV8833 truth table (xIN1=H, xIN2=L → forward; xIN1=L, xIN2=H → reverse):

| Command     | AIN1 (GPIO 20) | AIN2 (GPIO 21) |
|-------------|---------------|---------------|
| forward     | HIGH          | LOW           |
| turn_left   | LOW           | HIGH          |
| stop/coast  | LOW           | LOW           |

If forward and turn are physically reversed after assembly, swap the AIN1 / AIN2 pin assignments
in `esp32/octobot.ino` (the `#define` lines at the top).

## Power

- **DRV8833 VM**: wire directly to the battery positive rail (4×AA ≈ 6 V). VM range is 2.7–10.8 V.
- **ESP32 3.3 V**: use the ESP32 devkit's onboard 3.3 V regulator (fed from USB during development;
  for standalone use, feed the devkit's 5 V pin from a 5 V LDO/buck tied to the battery).
- **Common GND**: battery negative, DRV8833 GND, and ESP32 GND must all connect.

No extra capacitors on the motor supply are required beyond the 100 µF bulk cap — the DRV8833 has
internal bootstrap circuitry. The original PCB's caps were there because the original brain IC had
no such protection.

## Software architecture

### Previous approach (FT232H)

```
Server (laptop) → WebSocket → Phone browser → WebUSB/FT232H → H-bridge → Motor
```

The phone acted as a USB-to-GPIO adapter. This required the phone to stay connected over USB.

### New approach (ESP32 WiFi)

```
Server (laptop) → HTTP POST /motor → ESP32 WiFi → DRV8833 → Motor
Phone: audio input/output, display, camera only
```

The ESP32 connects to the same WiFi network as the server. Set `ESP32_URL=http://<esp32-ip>` in the
server environment. The server calls the ESP32 directly; the phone no longer participates in motor
control.

### About USB from phone to ESP32

The FT232H used WebUSB (vendor-specific USB class, supported in Chrome/Edge).
The ESP32's built-in USB port enumerates as a CDC-Serial device, which requires the **Web Serial
API** (different from WebUSB). Chrome/Edge on Android support Web Serial, but:

- iOS Safari supports neither WebUSB nor Web Serial.
- The existing `motor.ts` client code speaks the FTDI protocol; it would need a full rewrite.
- WiFi removes the USB cable entirely and lets the server drive the motor without routing through
  the phone, which is simpler and more reliable.

WiFi is the recommended path. Web Serial is an option only if a USB tether from phone to ESP32 is
specifically required and iOS is not a target.

## ESP32 firmware

See `esp32/src/main.cpp` and `esp32/platformio.ini`. The firmware uses the Arduino framework
targeting ESP32 — no Arduino IDE needed.

### Tooling: PlatformIO in VS Code

1. Install the [PlatformIO IDE extension](https://marketplace.visualstudio.com/items?itemName=platformio.platformio-ide) in VS Code.
2. Open the `esp32/` folder (`File → Open Folder`).
3. PlatformIO detects `platformio.ini` and downloads the ESP32 toolchain and libraries automatically.
4. Click **Upload** (→ icon) or run `pio run --target upload` to flash.
5. Click **Monitor** (plug icon) or `pio device monitor` for Serial output.

Libraries are declared in `platformio.ini` under `lib_deps` — no manual installs:

- **ArduinoJson** 7.x (`bblanchon/ArduinoJson`)
- **WiFiManager** 2.0.x (`tzapu/WiFiManager`)

If your board is not a generic ESP32 DevKit, change the `board` value in `platformio.ini`.
See the comment at the top of that file for common alternatives (S3, C3, etc.).

### WiFi credentials — no hardcoding

Credentials are **not** in the sketch file and not in git. Instead WiFiManager is used:

1. First boot (or after a credential reset): ESP32 creates an open AP called **`PiBot-Setup`**.
2. Connect to it from any phone or laptop.
3. Open `http://192.168.4.1` — a captive portal lets you pick your SSID and enter the password.
4. Credentials are saved to ESP32 NVS flash and reused on every subsequent boot.
5. To reconfigure: hold the **BOOT button (GPIO 0)** for 3 seconds at startup.

After first-time setup, open Serial Monitor at 115200 baud to read the assigned IP, then set
`ESP32_URL=http://<ip>` in the server environment.

The `/motor` endpoint blocks for `durationMs` before responding, so the HTTP response signals
completion — this matches the existing RPC semantics where the server waits for the tool to finish
before the LLM receives the result.

## Server integration

Set `ESP32_URL=http://<esp32-ip>` in the environment. When this is set, the server's motor tool
sends commands directly to the ESP32 via HTTP instead of forwarding through the phone's WebSocket
connection. The phone WebSocket path remains as a fallback when `ESP32_URL` is not set.

`turn_left_degrees` (which normally uses the phone's orientation sensor for closed-loop angle
control) falls back to a timed `turn_left` when routing through the ESP32 — the server already
pre-calculates `durationMs` from the requested degrees, so the behaviour degrades gracefully.
