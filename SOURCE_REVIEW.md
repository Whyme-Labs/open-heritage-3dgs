# Source and implementation review

## Confirmed result from the first run

Pantheon Interior completed successfully:

```text
Total gaussians loaded: 500000
SHA-256: d856f4b4f7de0c7ff2ed1b28dc3813c6651d8b0c0dd19729685ca850f54bbc16
```

That proves the scene URL resolver, SOG reader, decimator, and PLY writer worked for the Pantheon source.

## Saka Shrine failure

The Saka scene resolved to a Streamed SOG descriptor:

```text
https://d28zzqy0iyovbz.cloudfront.net/3f8c617d/v1/lod-meta.json
```

The CDN returned HTTP 403 before the data could be read. This is different from a malformed PLY, insufficient memory, or a decimation failure. The revised script records the failure, explains the manual fallback, and continues to later scenes.

## Viewer architecture

The new prototype uses the official SuperSplat Viewer as a local static application.

- WebGPU is preferred.
- WebGL2 is the fallback.
- PLY, compressed PLY, SOG, and streamed SOG are supported.
- The server supports byte ranges.
- Mobile and desktop share the same viewer runtime.
- A local shell handles scene selection, quality, attribution, and availability.

## Boundary architecture

There are two separate controls.

### Camera geofence

This always works after the splat loads. It derives the scene AABB or reads an explicit box/polygon. The camera is projected back to the permitted region when it crosses the boundary.

This protects against:

- flying indefinitely into empty space,
- losing the scene,
- orbiting excessively far away,
- leaving a guided prototype area.

It does not identify walls.

### Collision geometry

A generated voxel or GLB collision asset is passed into the viewer. The native walk controller uses it for floor and obstacle tests.

This protects against:

- walking through walls,
- falling through floors,
- entering sealed geometry.

Collision quality depends on scene completeness, voxel resolution, opacity threshold, and seed placement. It requires scene-by-scene inspection.

## Mobile input

The movement joystick emits standard keyboard codes into the viewer's native input path. This lets the viewer decide whether to fly or walk and preserves collision behavior. The look pad updates camera orientation through the viewer's camera-state interface. A separate frame loop enforces the configured geofence regardless of whether input came from desktop, touch gestures, or the mobile overlay.

## Acceptance tests

- Load Pantheon PLY before converting it.
- Confirm the renderer badge says WebGPU active on a compatible browser.
- Force WebGL2 from the main page and confirm fallback operation.
- Walk or fly toward every boundary face.
- Verify the camera stops and the boundary notice appears.
- Test movement joystick and look pad on iOS and Android.
- Convert to SOG and compare first-frame time and transferred bytes.
- Generate collision, then test the floor, major walls, doorway openings, and stairs.
- Edit the scene boundary to a polygon and verify corner projection.
- Reload each scene and confirm the source and attribution remain accessible.
