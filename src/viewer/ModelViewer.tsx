import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { addLights, disposeObject, frameObject, loadModel } from "./loadModel";

interface Props {
  path: string;
}

/** Interactive orbit viewer for a single model file. */
export function ModelViewer({ path }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | string>("loading");
  const [dims, setDims] = useState<THREE.Vector3 | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    setStatus("loading");
    setDims(null);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    addLights(scene);
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    const render = () => renderer.render(scene, camera);
    let frame = 0;
    const loop = () => {
      if (controls.update()) render();
      frame = requestAnimationFrame(loop);
    };
    controls.addEventListener("change", render);

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = el;
      if (!w || !h) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      render();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    let model: THREE.Object3D | null = null;
    let grid: THREE.GridHelper | null = null;
    loadModel(path)
      .then((obj) => {
        if (disposed) return disposeObject(obj);
        model = obj;
        scene.add(obj);
        const { target, size } = frameObject(camera, obj);
        controls.target.copy(target);
        // Grid in 10 mm squares sized to the part, like a build plate.
        const span = Math.max(size.x, size.z) * 1.6;
        const cells = Math.max(2, Math.ceil(span / 10));
        grid = new THREE.GridHelper(cells * 10, cells, 0x888888, 0x555555);
        (grid.material as THREE.Material).transparent = true;
        (grid.material as THREE.Material).opacity = 0.35;
        scene.add(grid);
        setDims(size);
        setStatus("ready");
        resize();
      })
      .catch((e) => !disposed && setStatus(String(e)));

    frame = requestAnimationFrame(loop);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      ro.disconnect();
      controls.dispose();
      if (model) disposeObject(model);
      grid?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [path]);

  return (
    <div className="viewer">
      <div className="viewer-canvas" ref={host} />
      {status === "loading" && <div className="viewer-overlay">Loading model…</div>}
      {status !== "loading" && status !== "ready" && <div className="viewer-overlay error">{status}</div>}
      {dims && (
        <div className="viewer-dims">
          {dims.x.toFixed(1)} × {dims.z.toFixed(1)} × {dims.y.toFixed(1)} mm
        </div>
      )}
    </div>
  );
}
