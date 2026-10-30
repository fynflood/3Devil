import { useEffect, useState } from "react";
import * as THREE from "three";
import { get, set } from "idb-keyval";
import { THUMB_RESOLUTION, addLights, disposeObject, frameObject, loadModel } from "./loadModel";

const SIZE = 256;

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;

function setup() {
  if (renderer && !renderer.getContext().isContextLost()) return;
  renderer?.dispose();
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(SIZE, SIZE);
  scene = new THREE.Scene();
  addLights(scene);
  camera = new THREE.PerspectiveCamera(30, 1, 0.1, 10000);
}

async function renderThumb(path: string, fileSize: number): Promise<Blob> {
  setup();
  const obj = await loadModel(path, THUMB_RESOLUTION, fileSize);
  scene!.add(obj);
  frameObject(camera!, obj);
  renderer!.render(scene!, camera!);
  scene!.remove(obj);
  disposeObject(obj);
  return new Promise((resolve, reject) =>
    renderer!.domElement.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
  );
}

// Render one thumbnail at a time so a large project doesn't flood the GPU / IPC.
let chain: Promise<unknown> = Promise.resolve();
const urls = new Map<string, Promise<string | null>>();

function keyFor(path: string, size: number) {
  return `thumb:v1:${path}:${size}`;
}

export function thumbnailUrl(path: string, size: number): Promise<string | null> {
  const key = keyFor(path, size);
  let p = urls.get(key);
  if (!p) {
    p = (async () => {
      const cached = await get<Blob>(key).catch(() => undefined);
      if (cached) return URL.createObjectURL(cached);
      const job = chain.then(() => renderThumb(path, size));
      chain = job.catch(() => undefined);
      const blob = await job;
      await set(key, blob).catch(() => undefined);
      return URL.createObjectURL(blob);
    })().catch((e) => {
      console.warn(`Thumbnail failed for ${path}:`, e);
      return null;
    });
    urls.set(key, p);
  }
  return p;
}

/** Lazily resolves a cached thumbnail once `visible` becomes true. */
export function useThumbnail(path: string, size: number, visible: boolean) {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!visible) return;
    let live = true;
    thumbnailUrl(path, size).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [path, size, visible]);
  return url;
}
