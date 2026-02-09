#!/usr/bin/env python3
"""
BPM detection using librosa's beat tracker.

Usage: python detect_bpm.py <audio_file>
Outputs JSON: {"bpm": 128.0, "firstBeatTime": 0.12}
"""

import sys
import json
import numpy as np
import librosa


def detect_bpm(audio_path):
    # Load audio (mono, native sample rate)
    y, sr = librosa.load(audio_path, sr=None, mono=True)

    # Get tempo estimate and beat frame positions
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)

    # tempo may be an array (librosa >= 0.10), extract scalar
    bpm = float(np.atleast_1d(tempo)[0])
    bpm = round(bpm, 2)

    # Convert beat frames to timestamps
    beat_times = librosa.frames_to_time(beat_frames, sr=sr)

    first_beat_time = round(float(beat_times[0]), 4) if len(beat_times) > 0 else 0.0

    return {
        "bpm": bpm,
        "firstBeatTime": first_beat_time,
    }


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(json.dumps({"error": "Usage: python detect_bpm.py <audio_file>"}))
        sys.exit(1)

    audio_path = sys.argv[1]
    try:
        result = detect_bpm(audio_path)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
