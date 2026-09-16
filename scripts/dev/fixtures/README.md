# Creation provider fixture

`video-with-audio.mp4` is a generated five-second 320×180 H.264/AAC MP4.
It contains a test pattern and a 440 Hz sine wave; no external or user media.
The fake Kapon route, media probe and Electron video tracer share these bytes.

Regenerate with FFmpeg:

```bash
ffmpeg -f lavfi -i 'testsrc=size=320x180:rate=10:duration=5' \
  -f lavfi -i 'sine=frequency=440:duration=5' \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 32k \
  -movflags +faststart -shortest -y video-with-audio.mp4
```
