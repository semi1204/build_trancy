#!/usr/bin/env python3
import json
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

TOOL = "yt-dlp/yt-dlp"
PINNED_VERSION = "2026.08.19"
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
LANGUAGE = re.compile(r"^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*$")


def emit(payload, version=PINNED_VERSION):
    print(json.dumps({"schemaVersion": 1, "tool": TOOL, "toolVersion": version, **payload}, ensure_ascii=False))


def clean_text(value):
    return " ".join(str(value).split())


def json3_segments(data):
    segments = []
    for event in data.get("events", []):
        if not event.get("segs"):
            continue
        text = clean_text("".join(str(segment.get("utf8", "")) for segment in event["segs"]))
        if not text:
            continue
        start_ms = float(event.get("tStartMs", 0))
        duration_ms = float(event.get("dDurationMs", 0))
        segments.append({"start": start_ms / 1000, "end": (start_ms + duration_ms) / 1000, "text": text})
    return segments


def main():
    try:
        request = json.load(sys.stdin)
    except Exception as error:
        emit({"ok": False, "mode": "input", "libraryMs": None, "error": {"name": type(error).__name__, "message": str(error)}})
        return

    if request.get("mode") == "smoke":
        try:
            actual = subprocess.run(["yt-dlp", "--version"], check=True, capture_output=True, text=True).stdout.strip()
            emit({"ok": True, "mode": "smoke", "libraryMs": 0, "segments": []}, actual)
        except Exception as error:
            emit({"ok": False, "mode": "smoke", "libraryMs": None,
                  "error": {"name": type(error).__name__, "message": str(error)}})
        return

    video_id = request.get("videoId", "")
    language = request.get("lang", "")
    if not VIDEO_ID.fullmatch(video_id) or not LANGUAGE.fullmatch(language):
        emit({"ok": False, "mode": "live", "videoId": video_id, "lang": language, "libraryMs": None,
              "error": {"name": "InvalidInput", "message": "videoId 또는 lang 형식이 잘못됐습니다"}})
        return

    started = time.perf_counter()
    try:
        with tempfile.TemporaryDirectory(prefix="ytdual-bench-") as directory:
            output = str(Path(directory) / "source.%(ext)s")
            command = [
                "yt-dlp",
                "--ignore-config",
                "--no-plugin-dirs",
                "--no-cache-dir",
                "--no-remote-components",
                "--no-playlist",
                "--js-runtimes", "node:/usr/local/bin/node",
                "--quiet",
                "--no-warnings",
                "--skip-download",
                "--write-subs",
                "--write-auto-subs",
                "--sub-langs", language,
                "--sub-format", "json3",
                "--output", output,
                f"https://www.youtube.com/watch?v={video_id}",
            ]
            completed = subprocess.run(command, capture_output=True, text=True)
            if completed.returncode != 0:
                detail = completed.stderr.strip().splitlines()[-6:]
                raise RuntimeError(" | ".join(detail) or f"yt-dlp 종료 코드 {completed.returncode}")
            files = sorted(Path(directory).glob("source.*.json3"))
            if len(files) != 1:
                raise RuntimeError(f"JSON3 자막 파일 수가 1이 아닙니다: {len(files)}")
            segments = json3_segments(json.loads(files[0].read_text(encoding="utf-8")))
        emit({"ok": True, "mode": "live", "videoId": video_id, "lang": language,
              "libraryMs": round((time.perf_counter() - started) * 1000), "segments": segments})
    except Exception as error:
        emit({"ok": False, "mode": "live", "videoId": video_id, "lang": language,
              "libraryMs": round((time.perf_counter() - started) * 1000),
              "error": {"name": type(error).__name__, "message": str(error)}})


if __name__ == "__main__":
    main()
