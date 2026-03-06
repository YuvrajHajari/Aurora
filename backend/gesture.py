"""
gesture.py — MediaPipe Tasks API (mediapipe >= 0.10.30)
────────────────────────────────────────────────────────
Uses a gesture STATE MACHINE so only one gesture fires at a time.

States:
  IDLE        → watching for any gesture to begin
  PINCHING    → thumb+index held close, volume/swipe locked out
  SWIPING     → fast horizontal motion detected, locks out volume
  VOLUME      → open palm held still for 0.4s, then height = volume

Transitions:
  IDLE  → PINCHING   : dist(thumb,index) < PINCH_THRESHOLD
  IDLE  → SWIPING    : fast x-velocity detected (open hand)
  IDLE  → VOLUME     : open palm, hand stationary for VOLUME_SETTLE_TIME
  PINCHING → IDLE    : pinch released (fires toggle_play on release edge)
  SWIPING  → IDLE    : swipe completed or timed out
  VOLUME   → IDLE    : hand starts moving fast or leaves frame
"""

import cv2
import mediapipe as mp
import math
import time
import base64
import os
from threading import Event
from enum import Enum, auto

from mediapipe.tasks.python        import vision, BaseOptions
from mediapipe.tasks.python.vision import (
    HandLandmarker,
    HandLandmarkerOptions,
    RunningMode,
)

# ── Hand connections ──────────────────────────────────────────
HAND_CONNECTIONS = [
    (0,1),(1,2),(2,3),(3,4),
    (0,5),(5,6),(6,7),(7,8),
    (5,9),(9,10),(10,11),(11,12),
    (9,13),(13,14),(14,15),(15,16),
    (13,17),(17,18),(18,19),(19,20),
    (0,17),
]
FINGERTIPS = {4, 8, 12, 16, 20}

# ── Aurora palette (BGR) ──────────────────────────────────────
C_MINT    = (167, 243, 208)
C_EMERALD = (52,  211, 153)
C_AMBER   = (251, 191,  36)
C_ROSE    = (100, 100, 250)   # volume mode indicator
C_WHITE   = (255, 255, 255)
FONT      = cv2.FONT_HERSHEY_SIMPLEX

MODEL_PATH = os.path.join(os.path.dirname(__file__), "hand_landmarker.task")


class State(Enum):
    IDLE     = auto()
    PINCHING = auto()
    SWIPING  = auto()
    VOLUME   = auto()


class GestureController:
    # ── Thresholds ────────────────────────────────────────────
    PINCH_ENTER      = 0.052   # dist to enter pinch
    PINCH_EXIT       = 0.070   # dist to exit pinch (hysteresis)
    PINCH_COOLDOWN   = 0.9

    SWIPE_MIN_VEL    = 0.018   # normalized x units per frame to start swipe
    SWIPE_DIST       = 0.22    # total x distance to confirm swipe
    SWIPE_TIMEOUT    = 0.6     # seconds to complete swipe
    SWIPE_COOLDOWN   = 1.0

    VOLUME_SETTLE    = 0.35    # seconds palm must be still before volume mode
    VOLUME_STILL_THR = 0.015   # max wrist movement to stay "still"
    VOLUME_COOLDOWN  = 0.07    # how often to emit volume events
    VOLUME_CHANGE    = 0.025   # min y-change to emit

    def __init__(self):
        self.callback     = None
        self._stop        = Event()
        self._state       = State.IDLE

        # Pinch
        self._last_pinch_fire = 0

        # Swipe
        self._swipe_start_x    = None
        self._swipe_start_time = None
        self._last_swipe_fire  = 0
        self._prev_wrist_x     = None

        # Volume
        self._still_since      = None   # when wrist became still
        self._last_vol_emit    = 0
        self._last_vol_y       = None
        self._last_wrist_pos   = None   # (x,y) for movement detection

    def set_callback(self, fn):
        self.callback = fn

    def _emit(self, event: dict):
        if self.callback:
            self.callback(event)

    # ── Geometry ─────────────────────────────────────────────

    def _dist(self, lm, i, j):
        return math.sqrt((lm[i].x-lm[j].x)**2 + (lm[i].y-lm[j].y)**2)

    def _wrist(self, lm):
        return lm[0].x, lm[0].y

    def _is_open_palm(self, lm) -> bool:
        """All 4 fingers extended (tips higher than knuckles in image = lower y)."""
        tips    = [8, 12, 16, 20]
        knuckle = [6, 10, 14, 18]
        return all(lm[t].y < lm[k].y for t, k in zip(tips, knuckle))

    # ── STATE MACHINE ─────────────────────────────────────────

    def _process(self, lm) -> tuple[str, bool]:
        """
        Run one frame through the state machine.
        Returns (gesture_label, is_pinching) for drawing.
        """
        now      = time.time()
        wx, wy   = self._wrist(lm)
        pinch_d  = self._dist(lm, 4, 8)
        label    = ""
        pinching = False

        # ── Track wrist velocity ──────────────────────────────
        wrist_moved = 0.0
        if self._last_wrist_pos:
            dx = wx - self._last_wrist_pos[0]
            dy = wy - self._last_wrist_pos[1]
            wrist_moved = math.sqrt(dx*dx + dy*dy)
            wrist_vel_x = abs(dx)
        else:
            wrist_vel_x = 0.0
        self._last_wrist_pos = (wx, wy)

        # ══════════════════════════════════════════════════════
        if self._state == State.IDLE:

            # Priority 1: Pinch
            if pinch_d < self.PINCH_ENTER:
                self._state  = State.PINCHING
                pinching     = True
                label        = "PINCH HELD"

            # Priority 2: Fast horizontal swipe (open hand)
            elif wrist_vel_x > self.SWIPE_MIN_VEL and self._is_open_palm(lm):
                if now - self._last_swipe_fire > self.SWIPE_COOLDOWN:
                    self._state            = State.SWIPING
                    self._swipe_start_x    = wx
                    self._swipe_start_time = now
                    label                  = "SWIPE STARTING..."

            # Priority 3: Open palm held still → volume mode
            elif self._is_open_palm(lm):
                if wrist_moved < self.VOLUME_STILL_THR:
                    if self._still_since is None:
                        self._still_since = now
                    elif now - self._still_since >= self.VOLUME_SETTLE:
                        self._state = State.VOLUME
                        label       = "VOLUME MODE"
                else:
                    self._still_since = None

        # ══════════════════════════════════════════════════════
        elif self._state == State.PINCHING:
            pinching = True

            if pinch_d > self.PINCH_EXIT:
                # Released — fire toggle on release edge
                if now - self._last_pinch_fire > self.PINCH_COOLDOWN:
                    self._last_pinch_fire = now
                    self._emit({"type": "gesture", "action": "toggle_play"})
                    label = "⏯  PINCH → pause/play"
                self._state = State.IDLE
                self._still_since = None
            else:
                label = "PINCH HELD  ⏯"

        # ══════════════════════════════════════════════════════
        elif self._state == State.SWIPING:
            elapsed = now - self._swipe_start_time
            delta_x = wx - self._swipe_start_x

            if abs(delta_x) >= self.SWIPE_DIST:
                direction = "left" if delta_x < 0 else "right"
                if direction == "right":
                    label = "▶▶  SWIPE RIGHT → next"
                    self._emit({"type": "gesture", "action": "next"})
                else:
                    label = "◀◀  SWIPE LEFT → prev"
                    self._emit({"type": "gesture", "action": "prev"})
                self._last_swipe_fire = now
                self._state = State.IDLE

            elif elapsed > self.SWIPE_TIMEOUT:
                # Timed out — cancel
                self._state = State.IDLE
            else:
                label = f"SWIPING... {delta_x:+.2f}"

        # ══════════════════════════════════════════════════════
        elif self._state == State.VOLUME:
            # Exit volume mode if hand closes or moves too fast
            if not self._is_open_palm(lm) or wrist_moved > self.VOLUME_STILL_THR * 4:
                self._state       = State.IDLE
                self._still_since = None
                label             = "VOLUME MODE OFF"
            else:
                vol = round(max(0.0, min(1.0, 1.0 - wy)), 3)
                if (now - self._last_vol_emit > self.VOLUME_COOLDOWN and
                        (self._last_vol_y is None or
                         abs(vol - self._last_vol_y) >= self.VOLUME_CHANGE)):
                    self._last_vol_y   = vol
                    self._last_vol_emit = now
                    self._emit({"type": "gesture", "action": "volume", "value": vol})

                bars  = "█" * int(vol * 10) + "░" * (10 - int(vol * 10))
                label = f"VOL  {bars}  {int(vol*100)}%"

        return label, pinching

    # ── Drawing ───────────────────────────────────────────────

    def _state_color(self):
        return {
            State.IDLE:     C_MINT,
            State.PINCHING: C_AMBER,
            State.SWIPING:  C_EMERALD,
            State.VOLUME:   C_ROSE,
        }.get(self._state, C_MINT)

    def _draw_skeleton(self, frame, lm, pinching):
        h, w = frame.shape[:2]
        col  = self._state_color()

        for s, e in HAND_CONNECTIONS:
            x1,y1 = int(lm[s].x*w), int(lm[s].y*h)
            x2,y2 = int(lm[e].x*w), int(lm[e].y*h)
            cv2.line(frame, (x1,y1), (x2,y2), col, 2, cv2.LINE_AA)

        for i, p in enumerate(lm):
            x, y   = int(p.x*w), int(p.y*h)
            is_tip = i in FINGERTIPS
            color  = C_AMBER if is_tip else col
            r      = 7 if is_tip else 4

            if pinching and i in {4, 8}:
                cv2.circle(frame, (x,y), r+5, C_WHITE,  2, cv2.LINE_AA)
                cv2.circle(frame, (x,y), r+5, C_AMBER,  1, cv2.LINE_AA)

            cv2.circle(frame, (x,y), r,   color,   -1, cv2.LINE_AA)
            cv2.circle(frame, (x,y), r+1, C_WHITE,  1, cv2.LINE_AA)

    def _draw_state_badge(self, frame):
        """Small state indicator in top-right corner."""
        h, w = frame.shape[:2]
        names = {State.IDLE:"IDLE", State.PINCHING:"PINCH",
                 State.SWIPING:"SWIPE", State.VOLUME:"VOL"}
        text  = names.get(self._state, "?")
        col   = self._state_color()
        (tw, th), _ = cv2.getTextSize(text, FONT, 0.55, 1)
        x = w - tw - 14
        cv2.rectangle(frame, (x-5, 8), (x+tw+5, th+16), (0,0,0), -1)
        cv2.rectangle(frame, (x-5, 8), (x+tw+5, th+16), col, 1)
        cv2.putText(frame, text, (x, th+10), FONT, 0.55, col, 1, cv2.LINE_AA)

    def _draw_label(self, frame, label):
        if not label:
            return
        col = self._state_color()
        (tw, th), _ = cv2.getTextSize(label, FONT, 0.72, 2)
        x, y = 12, 44
        cv2.rectangle(frame, (x-6,y-th-6), (x+tw+6,y+6), (0,0,0), -1)
        cv2.rectangle(frame, (x-6,y-th-6), (x+tw+6,y+6), col, 1)
        cv2.putText(frame, label, (x,y), FONT, 0.72, col, 2, cv2.LINE_AA)

    def _draw_volume_bar(self, frame):
        if self._state != State.VOLUME or self._last_vol_y is None:
            return
        h, w    = frame.shape[:2]
        bar_h   = int(h * 0.6)
        bx      = w - 26
        bt      = int(h * 0.2)
        bb      = bt + bar_h
        filled  = int(bar_h * self._last_vol_y)
        cv2.rectangle(frame, (bx, bt),           (bx+10, bb),           (30,30,30),  -1)
        cv2.rectangle(frame, (bx, bb - filled),  (bx+10, bb),           C_ROSE,      -1)
        cv2.rectangle(frame, (bx, bt),           (bx+10, bb),           C_MINT,       1)

    def _encode(self, frame) -> str:
        _, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 72])
        return base64.b64encode(buf).decode('utf-8')

    # ── Main loop ─────────────────────────────────────────────

    def start(self):
        if not os.path.exists(MODEL_PATH):
            print(f"[GESTURE] ❌ Model not found: {MODEL_PATH}")
            print("[GESTURE]    Run:  python download_model.py")
            return

        self._stop.clear()
        self._state = State.IDLE

        options = HandLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=MODEL_PATH),
            running_mode=RunningMode.VIDEO,
            num_hands=1,
            min_hand_detection_confidence=0.6,
            min_hand_presence_confidence=0.6,
            min_tracking_confidence=0.5,
        )

        cap = cv2.VideoCapture(0)

        with HandLandmarker.create_from_options(options) as detector:
            while not self._stop.is_set():
                ret, frame = cap.read()
                if not ret:
                    break

                frame    = cv2.flip(frame, 1)
                rgb      = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                mp_img   = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                ts_ms    = int(time.time() * 1000)
                result   = detector.detect_for_video(mp_img, ts_ms)

                label    = ""
                pinching = False

                if result.hand_landmarks:
                    lm            = result.hand_landmarks[0]
                    label, pinching = self._process(lm)
                    self._draw_skeleton(frame, lm, pinching)
                    self._draw_volume_bar(frame)
                else:
                    # Hand left frame — reset to IDLE
                    self._state       = State.IDLE
                    self._still_since = None
                    self._last_wrist_pos = None

                self._draw_state_badge(frame)
                self._draw_label(frame, label)
                self._emit({"type": "frame", "data": self._encode(frame)})
                time.sleep(0.033)

        cap.release()

    def stop(self):
        self._stop.set()