import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from faster_whisper import WhisperModel
from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError


ROOT = Path(__file__).resolve().parents[1]


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def now():
    return datetime.now(timezone.utc).isoformat()


def log(message):
    print(f"{now()} [TRANSCRIBE] {message}", flush=True)


def selected_shortcodes(cli_value=None):
    raw = os.environ.get("REEL_SHORTCODES") or cli_value
    if not raw:
        return []
    try:
        values = json.loads(raw) if raw.lstrip().startswith("[") else raw.split(",")
    except json.JSONDecodeError as error:
        raise SystemExit(f"Некорректный список shortcode: {error}") from error
    if not isinstance(values, list):
        raise SystemExit("Список shortcode должен быть массивом")
    result = []
    for value in values:
        shortcode = str(value).strip()
        if shortcode and shortcode not in result:
            result.append(shortcode)
    if not result:
        raise SystemExit("Список выбранных shortcode пуст")
    if len(result) > 500:
        raise SystemExit("За один запуск можно выбрать не более 500 рилсов")
    if any(not re.fullmatch(r"[A-Za-z0-9_-]{3,64}", shortcode) for shortcode in result):
        raise SystemExit("В списке выбранных рилсов найден некорректный shortcode")
    return result


class YtDlpLogger:
    def debug(self, message):
        if message.startswith("[download]") and "%" in message:
            log(message)

    def info(self, message):
        if message:
            log(message)

    def warning(self, message):
        log(f"yt-dlp: {message}")

    def error(self, message):
        log(f"yt-dlp: {message}")


def ensure_schema(db):
    columns = {
        "transcript": "TEXT",
        "transcript_language": "TEXT",
        "language_probability": "REAL",
        "transcript_segments": "TEXT",
        "transcript_model": "TEXT",
        "transcription_status": "TEXT",
        "transcription_error": "TEXT",
        "transcribed_at": "TEXT",
        "media_hash": "TEXT",
        "audio_kind": "TEXT",
        "transcription_recommendation": "TEXT",
        "transcription_reason": "TEXT",
    }
    existing = {row[1] for row in db.execute("PRAGMA table_info(reels)")}
    for name, column_type in columns.items():
        if name not in existing:
            db.execute(f"ALTER TABLE reels ADD COLUMN {name} {column_type}")
    db.commit()


def sha256_file(filename):
    digest = hashlib.sha256()
    with open(filename, "rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def existing_media(row):
    current = row["media_path"]
    if not current:
        return None
    candidate = Path(current)
    if not candidate.is_absolute():
        candidate = ROOT / candidate
    return candidate if candidate.exists() and candidate.stat().st_size > 0 else None


def direct_download(row, destination):
    video_url = row["video_url"]
    if not video_url or not video_url.startswith(("http://", "https://")):
        return None
    request = urllib.request.Request(
        video_url,
        headers={
            "Referer": row["url"],
            "User-Agent": "Mozilla/5.0",
        },
    )
    log(f"{row['shortcode']}: скачиваю сохранённый CDN-файл.")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            with open(destination, "wb") as target:
                while chunk := response.read(1024 * 1024):
                    target.write(chunk)
        if destination.stat().st_size == 0:
            raise RuntimeError("сервер вернул пустой файл")
        return destination
    except Exception as error:
        destination.unlink(missing_ok=True)
        log(f"{row['shortcode']}: сохранённая CDN-ссылка не сработала ({error}); получаю новую.")
        return None


def find_download(shortcode, output_dir):
    candidates = [
        item
        for item in output_dir.glob(f"{shortcode}.*")
        if item.is_file() and item.suffix not in {".part", ".ytdl"} and item.stat().st_size > 0
    ]
    return max(candidates, key=lambda item: item.stat().st_mtime, default=None)


def ytdlp_download(row, output_dir, browser_profile):
    shortcode = row["shortcode"]
    output_template = str(output_dir / f"{shortcode}.%(ext)s")
    common = {
        "format": "bestaudio/best",
        "outtmpl": output_template,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "retries": 3,
        "fragment_retries": 3,
        "socket_timeout": 30,
        "overwrites": True,
        "logger": YtDlpLogger(),
        "http_headers": {
            "Referer": "https://www.instagram.com/",
            "User-Agent": "Mozilla/5.0",
        },
    }
    attempts = [("публичная ссылка", common)]
    if browser_profile and browser_profile.exists():
        attempts.append(
            (
                "сохранённая сессия Instagram",
                {**common, "cookiesfrombrowser": ("chrome", str(browser_profile), None, None)},
            )
        )

    errors = []
    for label, options in attempts:
        log(f"{shortcode}: получаю медиа через yt-dlp ({label}).")
        try:
            with YoutubeDL(options) as downloader:
                downloader.extract_info(row["url"], download=True)
            downloaded = find_download(shortcode, output_dir)
            if downloaded:
                log(f"{shortcode}: медиа готово, {downloaded.stat().st_size / 1024 / 1024:.1f} МБ.")
                return downloaded
            errors.append(f"{label}: файл не появился")
        except (DownloadError, OSError, RuntimeError) as error:
            errors.append(f"{label}: {error}")

    raise RuntimeError("Не удалось получить медиа: " + " | ".join(errors))


def download_media(row, output_dir, browser_profile):
    current = existing_media(row)
    if current:
        return current

    output_dir.mkdir(parents=True, exist_ok=True)
    previous = find_download(row["shortcode"], output_dir)
    if previous:
        return previous

    destination = output_dir / f"{row['shortcode']}.mp4"
    downloaded = direct_download(row, destination)
    if downloaded:
        return downloaded

    return ytdlp_download(row, output_dir, browser_profile)


def main():
    parser = argparse.ArgumentParser(description="Локальная расшифровка Instagram Reels")
    parser.add_argument("--database", default="data/reels.sqlite")
    parser.add_argument("--media-dir", default="data/media")
    parser.add_argument("--model-dir", default="data/models")
    parser.add_argument("--browser-profile", default=".instagram-profile")
    parser.add_argument("--model", default="small")
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda", "auto"])
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--language", default=None)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--shortcodes", default=None, help="Точные shortcode через запятую")
    parser.add_argument("--beam-size", type=int, default=1)
    parser.add_argument("--threads", type=int, default=max(1, (os.cpu_count() or 4) - 1))
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--word-timestamps", action="store_true")
    args = parser.parse_args()

    database = (ROOT / args.database).resolve()
    media_dir = (ROOT / args.media_dir).resolve()
    model_dir = (ROOT / args.model_dir).resolve()
    browser_profile = (ROOT / args.browser_profile).resolve() if args.browser_profile else None
    if not database.exists():
        raise SystemExit(f"База не найдена: {database}")

    db = sqlite3.connect(database)
    db.row_factory = sqlite3.Row
    ensure_schema(db)

    selected = selected_shortcodes(args.shortcodes)
    parameters = []
    if selected:
        where = f"shortcode IN ({','.join('?' for _ in selected)})"
        parameters = selected
    else:
        where = "1 = 1" if args.force else "(transcription_status IS NULL OR transcription_status IN ('error', 'missing_media'))"
    sql = f"""
        SELECT * FROM reels
        WHERE {where}
        ORDER BY first_seen_at
    """
    if args.limit > 0 and not selected:
        sql += f" LIMIT {int(args.limit)}"
    rows = db.execute(sql, parameters).fetchall()
    if selected and len(rows) != len(selected):
        found = {row["shortcode"] for row in rows}
        missing = [shortcode for shortcode in selected if shortcode not in found]
        raise SystemExit(f"Рилсы не найдены в базе: {', '.join(missing)}")
    if not rows:
        log("Очередь пуста: все доступные записи уже обработаны.")
        db.close()
        return 0

    log(
        f"{'Выбрано' if selected else 'Очередь'}={len(rows)}, модель={args.model}, устройство={args.device}, "
        f"вычисления={args.compute_type}, потоки={args.threads}."
    )
    log("Загружаю модель. При первом запуске она будет скачана и сохранена локально.")
    model = WhisperModel(
        args.model,
        device=args.device,
        compute_type=args.compute_type,
        cpu_threads=args.threads,
        download_root=str(model_dir),
    )
    log("Модель готова.")

    complete = 0
    failed = 0
    for index, row in enumerate(rows, start=1):
        shortcode = row["shortcode"]
        log(f"[{index}/{len(rows)}] {shortcode}: подготовка.")
        db.execute(
            "UPDATE reels SET transcription_status = 'running', transcription_error = NULL WHERE shortcode = ?",
            (shortcode,),
        )
        db.commit()
        try:
            media_path = download_media(row, media_dir, browser_profile)
            media_hash = sha256_file(media_path)
            duplicate = db.execute(
                """
                SELECT shortcode, transcript, transcript_language, language_probability,
                       transcript_segments, transcript_model
                FROM reels
                WHERE media_hash = ? AND transcript IS NOT NULL AND shortcode != ?
                LIMIT 1
                """,
                (media_hash, shortcode),
            ).fetchone()
            if duplicate and not args.force:
                db.execute(
                    """
                    UPDATE reels SET
                        transcript = ?, transcript_language = ?, language_probability = ?,
                        transcript_segments = ?, transcript_model = ?,
                        transcription_status = 'complete', transcription_error = NULL,
                        transcribed_at = ?, media_hash = ?, media_path = ?,
                        audio_kind = CASE WHEN audio_kind IN ('music', 'viral_audio') THEN audio_kind ELSE 'speech' END,
                        transcription_recommendation = CASE WHEN audio_kind IN ('music', 'viral_audio') THEN transcription_recommendation ELSE 'recommended' END,
                        transcription_reason = CASE WHEN audio_kind IN ('music', 'viral_audio')
                            THEN transcription_reason
                            ELSE 'В аудио уже подтверждена разборчивая речь.' END
                    WHERE shortcode = ?
                    """,
                    (
                        duplicate["transcript"],
                        duplicate["transcript_language"],
                        duplicate["language_probability"],
                        duplicate["transcript_segments"],
                        duplicate["transcript_model"],
                        now(),
                        media_hash,
                        str(media_path),
                        shortcode,
                    ),
                )
                db.commit()
                complete += 1
                log(f"{shortcode}: аудиодубликат {duplicate['shortcode']}, результат переиспользован.")
                continue

            log(f"{shortcode}: распознаю речь.")
            segments_generator, info = model.transcribe(
                str(media_path),
                language=args.language,
                beam_size=args.beam_size,
                vad_filter=True,
                word_timestamps=args.word_timestamps,
                condition_on_previous_text=False,
            )
            segments = []
            text_parts = []
            for segment in segments_generator:
                text = segment.text.strip()
                if text:
                    text_parts.append(text)
                item = {
                    "start": round(segment.start, 3),
                    "end": round(segment.end, 3),
                    "text": text,
                }
                if args.word_timestamps and segment.words:
                    item["words"] = [
                        {
                            "start": round(word.start, 3),
                            "end": round(word.end, 3),
                            "word": word.word,
                            "probability": round(word.probability, 4),
                        }
                        for word in segment.words
                    ]
                segments.append(item)

            transcript = " ".join(text_parts).strip()
            status = "complete" if transcript else "no_speech"
            db.execute(
                """
                UPDATE reels SET
                    transcript = ?, transcript_language = ?, language_probability = ?,
                    transcript_segments = ?, transcript_model = ?,
                    transcription_status = ?, transcription_error = NULL,
                    transcribed_at = ?, media_hash = ?, media_path = ?,
                    audio_kind = CASE WHEN audio_kind IN ('music', 'viral_audio') THEN audio_kind WHEN ? = 'complete' THEN 'speech' ELSE 'no_speech' END,
                    transcription_recommendation = CASE WHEN audio_kind IN ('music', 'viral_audio') THEN transcription_recommendation WHEN ? = 'complete' THEN 'recommended' ELSE 'skip' END,
                    transcription_reason = CASE WHEN audio_kind IN ('music', 'viral_audio')
                        THEN transcription_reason
                        WHEN ? = 'complete'
                        THEN 'В аудио уже подтверждена разборчивая речь.'
                        ELSE 'Предыдущая проверка не обнаружила разборчивой речи.' END
                WHERE shortcode = ?
                """,
                (
                    transcript,
                    info.language,
                    float(info.language_probability),
                    json.dumps(segments, ensure_ascii=False),
                    f"faster-whisper:{args.model}:{args.compute_type}",
                    status,
                    now(),
                    media_hash,
                    str(media_path),
                    status,
                    status,
                    status,
                    shortcode,
                ),
            )
            db.commit()
            complete += 1
            log(
                f"{shortcode}: {status}, язык={info.language} "
                f"({info.language_probability:.2f}), символов={len(transcript)}."
            )
        except Exception as error:
            failed += 1
            db.execute(
                """
                UPDATE reels SET transcription_status = 'error', transcription_error = ?
                WHERE shortcode = ?
                """,
                (str(error), shortcode),
            )
            db.commit()
            log(f"{shortcode}: ОШИБКА: {error}")

    log(f"Готово: обработано={complete}, ошибок={failed}.")
    db.close()
    return 2 if failed else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nОстановлено пользователем.", file=sys.stderr)
        raise SystemExit(130)
