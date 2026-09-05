#!/usr/bin/env python3
import json
import re
import sys
import time
from importlib.metadata import version

from youtube_transcript_api import YouTubeTranscriptApi

TOOL = "jdepoix/youtube-transcript-api"
TOOL_VERSION = version("youtube-transcript-api")
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
LANGUAGE = re.compile(r"^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*$")


def emit(payload):
    print(json.dumps({"schemaVersion": 1, "tool": TOOL, "toolVersion": TOOL_VERSION, **payload}, ensure_ascii=False))


def clean_text(value):
    return " ".join(str(value).split())


def main():
    try:
        request = json.load(sys.stdin)
    except Exception as error:
        emit({"ok": False, "mode": "input", "libraryMs": None, "error": {"name": type(error).__name__, "message": str(error)}})
        return

    if request.get("mode") == "smoke":
        emit({"ok": True, "mode": "smoke", "libraryMs": 0, "segments": []})
        return

    video_id = request.get("videoId", "")
    language = request.get("lang", "")
    if not VIDEO_ID.fullmatch(video_id) or not LANGUAGE.fullmatch(language):
        emit({"ok": False, "mode": "live", "videoId": video_id, "lang": language, "libraryMs": None,
              "error": {"name": "InvalidInput", "message": "videoId 또는 lang 형식이 잘못됐습니다"}})
        return

    started = time.perf_counter()
    try:
        transcript = YouTubeTranscriptApi().fetch(video_id, languages=[language], preserve_formatting=False)
        segments = []
        for row in transcript.to_raw_data():
            text = clean_text(row.get("text", ""))
            if not text:
                continue
            start = float(row["start"])
            duration = float(row["duration"])
            segments.append({"start": start, "end": start + duration, "text": text})
        emit({"ok": True, "mode": "live", "videoId": video_id, "lang": language,
              "libraryMs": round((time.perf_counter() - started) * 1000), "segments": segments})
    except Exception as error:
        emit({"ok": False, "mode": "live", "videoId": video_id, "lang": language,
              "libraryMs": round((time.perf_counter() - started) * 1000),
              "error": {"name": type(error).__name__, "message": str(error)}})


if __name__ == "__main__":
    main()
