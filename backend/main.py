import os
import re
import json
import random
import httpx
import asyncio
import threading
import traceback
import pathlib
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
import firebase_admin
from firebase_admin import credentials, firestore
from gesture import GestureController

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

cred = credentials.Certificate("serviceAccountKey.json")
firebase_admin.initialize_app(cred)
db = firestore.client()

analyzer = SentimentIntensityAnalyzer()

HF_API_URL  = "https://router.huggingface.co/hf-inference/models/j-hartmann/emotion-english-distilroberta-base"
HF_TOKEN    = os.getenv("HF_API_TOKEN", "")
HF_HEADERS  = {"Authorization": f"Bearer {HF_TOKEN}"}
HF_TIMEOUT  = 10.0
HF_CONFIDENCE_THRESHOLD = 0.35

HF_TO_AURORA = {
    "joy": "happy", "sadness": "sad", "anger": "angry",
    "disgust": "angry", "fear": "sad", "surprise": "neutral", "neutral": "neutral",
}

VADER_LEXICON = {
    "angry": {
        "furious": 1.0, "enraged": 1.0, "livid": 1.0, "seething": 0.9,
        "outraged": 0.9, "infuriated": 0.9, "rage": 0.9, "angry": 0.8,
        "mad": 0.7, "pissed": 0.8, "frustrated": 0.7, "irritated": 0.6,
        "annoyed": 0.5, "hatred": 0.8, "hate": 0.7, "fed up": 0.7,
    },
    "sad": {
        "devastated": 1.0, "heartbroken": 1.0, "grief": 0.9, "depressed": 0.9,
        "hopeless": 0.9, "miserable": 0.9, "worthless": 0.8, "empty": 0.7,
        "lonely": 0.8, "abandoned": 0.8, "broken": 0.8, "sad": 0.7,
        "crying": 0.8, "numb": 0.7, "giving up": 0.8,
    },
    "happy": {
        "ecstatic": 1.0, "elated": 1.0, "thrilled": 0.9, "delighted": 0.9,
        "joyful": 0.9, "excited": 0.8, "grateful": 0.7, "wonderful": 0.8,
        "happy": 0.8, "fantastic": 0.8, "proud": 0.7, "blessed": 0.7,
    },
    "neutral": {
        "okay": 0.5, "fine": 0.5, "alright": 0.5, "meh": 0.5, "normal": 0.4,
    },
}

NEGATIONS    = {"not","no","never","don't","doesn't","didn't","won't","wouldn't","can't","cannot"}
INTENSIFIERS = {"very","so","really","extremely","incredibly","absolutely","utterly","completely","super"}
DIMINISHERS  = {"a bit","slightly","kind of","kinda","somewhat","a little","sort of"}
FLIP_MAP     = {"angry":"sad","sad":"neutral","happy":"sad","neutral":"neutral"}

RESPONSES = {
    "angry": [
        "I can feel the frustration in your words — that anger is completely valid. Let's bring the temperature down with something soothing.",
        "Something clearly got under your skin, and that's okay. Take a breath — I've queued something to help you decompress.",
        "Anger this strong usually means something important to you was crossed. I hear you. Let this music carry some of that weight.",
    ],
    "sad": [
        "I'm so sorry you're going through this. Grief and loss are some of the heaviest things we carry — you don't have to carry it alone.",
        "That kind of pain deserves to be felt, not rushed through. I've put on something gentle to sit with you.",
        "It's okay to not be okay. Whatever you're feeling — sadness, emptiness, grief — it's all valid. Let this play while you breathe.",
        "Some hurts don't have words. I hear what you're carrying, even in the silence between them.",
    ],
    "happy": [
        "That energy is absolutely contagious — let's ride this wave together! 🎉",
        "YES. This is the vibe. I found something to match exactly how you're feeling right now.",
        "You're glowing and it shows! Here's a track to keep that momentum going.",
    ],
    "neutral": [
        "Not every moment needs to be intense — sometimes just existing is enough. Here's something easy for your headspace.",
        "A steady, calm state is actually a really good place to be. Let this ambient track keep you grounded.",
        "I'll match your energy — nothing too heavy, nothing too light. Just something to float along with.",
    ],
}

TRANSITION_MSGS = {
    ("sad",     "happy"):   "I can feel a shift in you — something lifted. That matters. ",
    ("angry",   "neutral"): "You sound a little calmer now. I'm glad. ",
    ("angry",   "happy"):   "What a turnaround — I love this for you. ",
    ("happy",   "sad"):     "Something changed. I noticed. I'm still here. ",
    ("neutral", "sad"):     "I hear something heavier now. I'm with you. ",
    ("sad",     "neutral"): "You sound steadier. That's enough. ",
}

# ── HuggingFace ───────────────────────────────────────────────

async def query_huggingface(text: str) -> dict | None:
    if not HF_TOKEN:
        return None
    try:
        async with httpx.AsyncClient(timeout=HF_TIMEOUT) as client:
            resp = await client.post(HF_API_URL, headers=HF_HEADERS, json={"inputs": text})
        if resp.status_code != 200:
            return None
        raw   = resp.json()
        preds = sorted(raw[0] if isinstance(raw, list) else raw, key=lambda x: x["score"], reverse=True)
        top      = preds[0]
        hf_label = top["label"].lower()

        # ── Resolve "surprise" using VADER compound ───────────
        # HuggingFace tags many emotional sentences as "surprise"
        # (e.g. "over the moon", "can't believe they gave my project away").
        # We resolve it to the correct emotion using VADER's polarity.
        if hf_label == "surprise":
            compound = analyzer.polarity_scores(text)["compound"]
            if compound >= 0.15:
                hf_label = "joy"        # "over the moon" → happy
            elif compound <= -0.15:
                # Check for anger keywords; otherwise sad
                anger_words = {"unfair","unbelievable","outrageous","ridiculous",
                               "can't believe","cannot believe","furious","betrayed"}
                hf_label = "anger" if any(w in text.lower() for w in anger_words) else "sadness"
            else:
                hf_label = "neutral"    # genuinely ambiguous surprise

        aurora_emotion = HF_TO_AURORA.get(hf_label, "neutral")
        aurora_scores  = {"angry": 0.0, "sad": 0.0, "happy": 0.0, "neutral": 0.0}

        # Rebuild aurora_scores with the resolved label for the top pred
        for p in preds:
            lbl = p["label"].lower()
            if lbl == "surprise":
                lbl = hf_label   # use resolved label
            aurora_scores[HF_TO_AURORA.get(lbl, "neutral")] += p["score"]

        return {
            "emotion":      aurora_emotion,
            "confidence":   round(top["score"], 4),
            "hf_label":     hf_label,
            "aurora_scores":{e: round(v, 4) for e, v in aurora_scores.items()},
            "source":       "huggingface",
        }
    except Exception as e:
        print(f"[HF] {e}")
        return None

def tokenize(text): return re.findall(r"\b\w[\w']*\b", text.lower())

def vader_fallback(text: str) -> dict:
    tokens   = tokenize(text)
    compound = analyzer.polarity_scores(text)["compound"]
    lex      = {"angry": 0.0, "sad": 0.0, "happy": 0.0, "neutral": 0.0}
    for emotion, words in VADER_LEXICON.items():
        for phrase, weight in words.items():
            if len(phrase.split()) == 1:
                for idx, token in enumerate(tokens):
                    if token == phrase:
                        window = tokens[max(0, idx-2):idx]
                        mult   = 1.4 if set(window) & INTENSIFIERS else (0.6 if any(d in " ".join(window) for d in DIMINISHERS) else 1.0)
                        if set(tokens[max(0, idx-3):idx]) & NEGATIONS:
                            lex[FLIP_MAP.get(emotion, "neutral")] += weight * mult * 0.7
                        else:
                            lex[emotion] += weight * mult
            elif phrase in text.lower():
                lex[emotion] += weight
    vader_emo = "sad" if compound <= -0.1 else ("happy" if compound >= 0.1 else "neutral")
    combined  = dict(lex)
    combined[vader_emo] = combined.get(vader_emo, 0.0) + 0.5
    total = sum(combined.values()) or 1.0
    norm  = {e: v/total for e, v in combined.items()}
    top   = max(norm, key=norm.get)
    return {"emotion": top, "confidence": round(norm[top], 4), "compound": round(compound, 4), "source": "vader_fallback"}

async def detect_emotion(text: str, history: list = None) -> dict:
    # IMPORTANT: always detect on raw text only — never concatenate history.
    # History is used only for crafting Aurora's *response*, not for detection.
    # Concatenating history caused previous emotions to bleed into new detections.
    hf = await query_huggingface(text)
    if hf is None:
        r = vader_fallback(text); r["method"] = "vader_fallback"; return r
    if hf["confidence"] >= HF_CONFIDENCE_THRESHOLD:
        hf["method"] = "huggingface"; return hf
    vr      = vader_fallback(text)
    emotions = ["angry", "sad", "happy", "neutral"]
    blended  = {e: round(0.6*hf.get("aurora_scores",{}).get(e,0)+0.4*(1.0 if e==vr["emotion"] else 0), 4) for e in emotions}
    top      = max(blended, key=blended.get)
    return {"emotion": top, "confidence": round(blended[top],4), "hf_label": hf.get("hf_label"), "method": "blended_hf_vader", "blended_scores": blended}

# ── Music ─────────────────────────────────────────────────────

@app.get("/music/tracks/{mood}")
async def music_tracks(mood: str):
    doc = db.collection("moods").document(mood).get()
    if not doc.exists:
        return {"mood": mood, "tracks": []}
    raw = doc.to_dict().get("tracks", [])
    return {"mood": mood, "tracks": [{"name": t.get("track", t.get("name","Unknown")), "url": t.get("url","")} for t in raw]}

# ── Chat ──────────────────────────────────────────────────────

@app.post("/chat")
async def chat_endpoint(request: Request):
    data      = await request.json()
    user_text = data.get("text", "")
    history   = data.get("history", [])
    custom_dt = data.get("datetime")

    if not user_text.strip():
        return {"error": "Empty message"}

    result     = await detect_emotion(user_text, history)
    emotion    = result["emotion"]
    confidence = result["confidence"]

    track_url = track_name = ""
    doc = db.collection("moods").document(emotion).get()
    if doc.exists:
        tracks = doc.to_dict().get("tracks", [])
        if tracks:
            chosen     = random.choice(tracks)
            track_url  = chosen.get("url", "")
            track_name = chosen.get("track", chosen.get("name", ""))

    # Context-aware response
    response_text = random.choice(RESPONSES[emotion])
    if history:
        prev_emotions = [m.get("emotion") for m in history if m.get("emotion") and m.get("role") == "assistant"]
        if prev_emotions:
            key = (prev_emotions[-1], emotion)
            if key in TRANSITION_MSGS:
                response_text = TRANSITION_MSGS[key] + response_text

    # Auto-save to journal
    ts = custom_dt if custom_dt else datetime.utcnow().isoformat()
    try:
        db.collection("journal").add({
            "text": user_text, "emotion": emotion,
            "confidence": confidence, "timestamp": ts, "track": track_name,
        })
    except Exception as e:
        print(f"[JOURNAL] {e}")

    return {
        "mood":              emotion,
        "confidence":        confidence,
        "audio_url":         track_url,
        "track_name":        track_name,
        "response":          response_text,
        "trigger_breathing": emotion in ("sad","angry") and confidence >= 0.80,
        "debug": {
            "method":   result.get("method"),
            "hf_label": result.get("hf_label"),
            "scores":   result.get("blended_scores") or result.get("aurora_scores") or {},
        }
    }

# ── Journal ───────────────────────────────────────────────────

@app.get("/journal")
async def get_journal():
    docs = db.collection("journal").order_by("timestamp").stream()
    entries = []
    for doc in docs:
        d = doc.to_dict(); d["id"] = doc.id
        entries.append(d)
    return {"entries": entries}

@app.post("/journal")
async def add_journal_entry(request: Request):
    data = await request.json()
    text = data.get("text","")
    ts   = data.get("datetime", datetime.utcnow().isoformat())
    if not text.strip():
        return {"error": "Empty text"}
    result  = await detect_emotion(text)
    emotion = result["emotion"]
    db.collection("journal").add({
        "text": text, "emotion": emotion,
        "confidence": result["confidence"], "timestamp": ts, "track": "",
    })
    return {"emotion": emotion, "confidence": result["confidence"], "timestamp": ts}

@app.delete("/journal/{entry_id}")
async def delete_journal_entry(entry_id: str):
    db.collection("journal").document(entry_id).delete()
    return {"deleted": entry_id}

# ── Gesture WebSocket ─────────────────────────────────────────

@app.websocket("/ws/gesture")
async def gesture_websocket(websocket: WebSocket):
    await websocket.accept()
    loop         = asyncio.get_event_loop()
    gesture_ctrl = GestureController()
    def on_event(event):
        asyncio.run_coroutine_threadsafe(websocket.send_json(event), loop)
    gesture_ctrl.set_callback(on_event)
    threading.Thread(target=gesture_ctrl.start, daemon=True).start()
    try:
        while True:
            msg = await websocket.receive_text()
            if json.loads(msg).get("type") == "stop":
                gesture_ctrl.stop(); break
    except WebSocketDisconnect:
        gesture_ctrl.stop()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)