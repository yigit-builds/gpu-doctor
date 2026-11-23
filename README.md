# gpu-doctor

Is your GPU actually doing the work?

Most render and video tools don't crash when they can't reach the GPU. They quietly use the CPU and take 30x longer. On Linux, and on AMD cards especially, this is the default more often than not.

```
npx github:yigit-builds/gpu-doctor
```

Read-only, zero dependencies, about 5 seconds (`--quick` skips the Blender and ffmpeg tests, `--json` for scripts).

## What it checks

| check | what goes wrong |
|---|---|
| gpu + driver | no kernel driver bound, nouveau, missing `render` group |
| vulkan / opengl | only llvmpipe / lavapipe available |
| headless chrome (system, puppeteer, playwright) | WebGL falls back to SwiftShader. Tests which `--use-angle` flags reach the card, and catches the Wayland trap where `gl-egl` renders a blank canvas |
| ffmpeg | the hw encoder exists but nobody uses it. Runs a 1 s VAAPI / NVENC test encode |
| blender | Cycles can see the card (HIP / CUDA / OptiX / oneAPI) but the preference is still CPU |
| pytorch | CPU-only or wrong-vendor build |

Every failure prints the fix.

## On my machine (RX 5700 XT, Ubuntu 24.04, GNOME Wayland)

```
✓ gpu                  AMD (amdgpu)
✓ vulkan               AMD Radeon RX 5700 XT (RADV NAVI10)
✓ opengl               AMD Radeon RX 5700 XT (radeonsi, navi10, ...)
✗ chrome (system)      headless webgl runs on SwiftShader (cpu)
  → add these flags: --use-gl=angle --use-angle=vulkan
  → gl-egl only works with WAYLAND_DISPLAY unset ...
✓ ffmpeg encode        h264_vaapi works. most tools still default to libx264 (cpu)
✗ blender cycles       blender 5.2.2 LTS: HIP sees AMD Radeon RX 5700 XT, but cycles is set to cpu
```

What fixing those was worth, measured on that card:

- headless Chrome capture, 300 frames 1080p60: 1996 s → 27 s with `--use-angle=vulkan` ([teardown#12](https://github.com/elvarofficial/teardown/issues/12))
- HyperFrames WebGL render: 29 s → 7.5 s with `WAYLAND_DISPLAY` unset ([hyperframes#8604](https://github.com/heygen-com/hyperframes/pull/8604))
- Blender Cycles, 1080p, 256 samples: 326 s → 71 s after switching the device to HIP, same pixels

## Platforms

Linux only for now. macOS and Windows have their own versions of this problem (Metal vs. CPU in Blender, ANGLE backends in Chrome) and I can't test them myself. PRs from people who can are very welcome.

MIT
