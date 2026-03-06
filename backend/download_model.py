"""
Run this once before starting Aurora:
    python download_model.py

Downloads the MediaPipe hand landmarker model (~6MB) into the backend folder.
"""
import urllib.request
import os

MODEL_URL  = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
MODEL_PATH = os.path.join(os.path.dirname(__file__), "hand_landmarker.task")

if os.path.exists(MODEL_PATH):
    print(f"✅ Model already exists at: {MODEL_PATH}")
else:
    print("Downloading hand_landmarker.task (~6MB)...")
    urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
    print(f"✅ Saved to: {MODEL_PATH}")