/**
 * The wireframe stage (lot 4) — vector graphics in the spirit of a random
 * scan display: lines only, no surfaces, no textures, no lights.
 *
 * That is a look, but it is also what makes the scene affordable on the phone
 * of someone standing in a crowd: nothing to shade, no post-processing pass,
 * and a vertex count that fits in a cache. The phosphor persistence is done by
 * *not* clearing the frame and painting a nearly transparent black quad over
 * it, so the traces decay the way a tube's do — cheaper and more faithful than
 * a bloom pass.
 */

import {
  AdditiveBlending,
  Color,
  EdgesGeometry,
  GridHelper,
  Group,
  IcosahedronGeometry,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  TorusGeometry,
  WebGLRenderer,
} from "three";

export interface SceneInputs {
  /** Absolute musical position — drives rotation, so the scene turns with the
   * music rather than with the frame rate. */
  beat: number;
  /** 0..1 through the current beat: 0 is the downbeat. */
  beatPhase: number;
  /** 0..1 output level, straight from the analyser. */
  level: number;
  /** The musician's own parameter, 0..1. */
  param: number;
  /** Whether sound is actually playing; a stopped transport should look still. */
  playing: boolean;
}

export interface Visual {
  render(inputs: SceneInputs): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

/** How much of the previous frame survives: higher means longer trails. */
const PERSISTENCE = 0.72;

/** Radius the scene has to keep on screen. The camera distance is derived from
 * it and from the aspect ratio, because a phone held upright has a much
 * narrower horizontal field than a laptop: a fixed distance fits one and
 * crops the other. */
const SCENE_RADIUS = 2.9;

export function hasWebGL(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    return Boolean(
      canvas.getContext("webgl2") ??
        canvas.getContext("webgl") ??
        canvas.getContext("experimental-webgl"),
    );
  } catch {
    return false;
  }
}

export function createWireframeScene(
  canvas: HTMLCanvasElement,
  colorHex: string,
): Visual | null {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false });
  } catch {
    return null;
  }

  const color = new Color(colorHex);
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x040804, 1);
  // Persistence: the frame is never cleared, it is faded.
  renderer.autoClear = false;
  renderer.clear();

  const scene = new Scene();
  const camera = new PerspectiveCamera(52, 1, 0.1, 100);

  const material = new LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.9,
    blending: AdditiveBlending,
    depthWrite: false,
  });

  const world = new Group();
  scene.add(world);

  const coreGeometry = new EdgesGeometry(new IcosahedronGeometry(1, 1));
  const core = new LineSegments(coreGeometry, material);
  world.add(core);

  const ringGeometry = new EdgesGeometry(new TorusGeometry(1.9, 0.28, 4, 24));
  const ring = new LineSegments(ringGeometry, material);
  ring.rotation.x = Math.PI / 2.4;
  world.add(ring);

  // A grid running to the horizon: the oldest trick in vector graphics, and
  // still the fastest way to say "space" with twenty lines.
  const grid = new GridHelper(40, 40, color, color);
  grid.position.y = -3.2;
  const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
  for (const gridMaterial of gridMaterials) {
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.28;
    gridMaterial.blending = AdditiveBlending;
    gridMaterial.depthWrite = false;
  }
  scene.add(grid);

  // The fade quad, drawn in its own orthographic pass before each frame.
  const fadeScene = new Scene();
  const fadeCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const fadeMaterial = new MeshBasicMaterial({
    color: 0x040804,
    transparent: true,
    opacity: 1 - PERSISTENCE,
    depthWrite: false,
  });
  const fadeQuad = new Mesh(new PlaneGeometry(2, 2), fadeMaterial);
  fadeScene.add(fadeQuad);

  return {
    render({ beat, beatPhase, level, param, playing }) {
      // Decaying flash on each beat: bright on the downbeat, gone by the next.
      const pulse = playing ? Math.exp(-4.5 * beatPhase) : 0;
      const scale = 1 + pulse * 0.28 + level * 0.35;

      world.rotation.y = beat * 0.22;
      world.rotation.x = Math.sin(beat * 0.11) * 0.25;
      world.scale.setScalar(scale);
      core.rotation.z = -beat * 0.35;
      // The musician's own parameter opens the ring out: their gesture is
      // visible in the scene even when the room is loud.
      ring.rotation.z = beat * 0.18;
      ring.scale.setScalar(0.7 + param * 0.9);

      // Kept below full so the controls in front stay readable over it.
      material.opacity = 0.32 + pulse * 0.42 + level * 0.18;
      // The floor slides by one cell per bar, which is what turns a static
      // grid into travel.
      grid.position.z = (beat % 4) * 0.25;

      renderer.render(fadeScene, fadeCamera);
      renderer.render(scene, camera);
    },

    resize(width, height) {
      renderer.setSize(width, height, false);
      const aspect = width / Math.max(height, 1);
      camera.aspect = aspect;

      // Pull back far enough that the scene fits on the tighter of the two
      // axes — the horizontal one in portrait, the vertical one in landscape.
      const vFov = (camera.fov * Math.PI) / 180;
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
      const distance = SCENE_RADIUS / Math.tan(Math.min(vFov, hFov) / 2);
      camera.position.set(0, distance * 0.18, distance);
      camera.lookAt(0, -0.3, 0);

      camera.updateProjectionMatrix();
      renderer.clear();
    },

    dispose() {
      // A leaked GPU buffer on a phone is not a slow leak, it is a dead tab.
      coreGeometry.dispose();
      ringGeometry.dispose();
      material.dispose();
      grid.geometry.dispose();
      for (const gridMaterial of gridMaterials) gridMaterial.dispose();
      fadeQuad.geometry.dispose();
      fadeMaterial.dispose();
      renderer.dispose();
    },
  };
}

/**
 * The same vocabulary in 2D, for a device without WebGL (§6.3). It draws the
 * same kind of lines with the same trail, so the degradation costs detail
 * rather than identity.
 */
export function createFallbackScene(canvas: HTMLCanvasElement, colorHex: string): Visual {
  const ctx = canvas.getContext("2d");
  let width = canvas.width;
  let height = canvas.height;

  return {
    render({ beat, beatPhase, level, param, playing }) {
      if (!ctx) return;
      const pulse = playing ? Math.exp(-4.5 * beatPhase) : 0;

      // Same persistence trick: paint the ground over the last frame.
      ctx.fillStyle = `rgba(4, 8, 4, ${1 - PERSISTENCE})`;
      ctx.fillRect(0, 0, width, height);

      const cx = width / 2;
      const cy = height / 2;
      const radius = Math.min(width, height) * (0.18 + pulse * 0.05 + level * 0.07);

      ctx.strokeStyle = colorHex;
      ctx.globalAlpha = 0.45 + pulse * 0.5;
      ctx.lineWidth = 1;

      // A rotating polygon and its inscribed star: two paths, and it reads as
      // the same object as the 3D one.
      for (const [sides, scale, spin] of [
        [6, 1, beat * 0.22],
        [3, 0.6 + param * 0.5, -beat * 0.35],
      ] as const) {
        ctx.beginPath();
        for (let i = 0; i <= sides; i++) {
          const angle = spin + (i / sides) * Math.PI * 2;
          const x = cx + Math.cos(angle) * radius * scale;
          const y = cy + Math.sin(angle) * radius * scale;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // The horizon grid, in perspective by hand.
      ctx.globalAlpha = 0.18;
      const horizon = cy + height * 0.22;
      for (let i = -6; i <= 6; i++) {
        ctx.beginPath();
        ctx.moveTo(cx + i * width * 0.08, horizon);
        ctx.lineTo(cx + i * width * 0.34, height);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    },

    resize(nextWidth, nextHeight) {
      width = nextWidth;
      height = nextHeight;
      canvas.width = nextWidth;
      canvas.height = nextHeight;
    },

    dispose() {
      ctx?.clearRect(0, 0, width, height);
    },
  };
}
