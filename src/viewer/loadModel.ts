import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { ThreeMFLoader } from "three/examples/jsm/loaders/3MFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { api, extOf } from "../api";

export const PART_COLOR = 0xe2683c;

export function partMaterial(color = PART_COLOR) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, flatShading: false });
}

/**
 * Loads a model file into a Z-up-corrected group whose bottom sits on y=0
 * and whose footprint is centred on the origin (like a slicer build plate).
 */
export async function loadModel(path: string, color?: number): Promise<THREE.Group> {
  const bytes = await api.readFileBytes(path);
  const ext = extOf(path);
  const material = partMaterial(color);
  const group = new THREE.Group();

  if (ext === "stl") {
    const geom = new STLLoader().parse(bytes);
    geom.computeVertexNormals();
    group.add(new THREE.Mesh(geom, material));
  } else if (ext === "3mf") {
    const obj = new ThreeMFLoader().parse(bytes);
    obj.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = material;
    });
    group.add(obj);
  } else if (ext === "obj") {
    const obj = new OBJLoader().parse(new TextDecoder().decode(bytes));
    obj.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = material;
    });
    // OBJ is conventionally Y-up already; undo the Z-up rotation applied below.
    obj.rotation.x = Math.PI / 2;
    group.add(obj);
  } else {
    throw new Error(`Unsupported file type: .${ext}`);
  }

  // Printing formats are Z-up; three.js is Y-up.
  const wrapper = new THREE.Group();
  group.rotation.x = -Math.PI / 2;
  wrapper.add(group);
  wrapper.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(wrapper);
  const center = box.getCenter(new THREE.Vector3());
  group.position.set(-center.x, -box.min.y, -center.z);
  return wrapper;
}

export function disposeObject(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mats.forEach((m) => m?.dispose());
  });
}

export function addLights(scene: THREE.Scene) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.8);
  key.position.set(1, 1.6, 1.2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 0.6);
  rim.position.set(-1.2, 0.6, -1);
  scene.add(rim);
}

/** Positions a camera for a 3/4 view that fits the given object. */
export function frameObject(camera: THREE.PerspectiveCamera, obj: THREE.Object3D, target = new THREE.Vector3()) {
  const box = new THREE.Box3().setFromObject(obj);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const r = Math.max(sphere.radius, 0.001);
  const dist = r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.05;
  target.copy(sphere.center);
  const dir = new THREE.Vector3(1, 0.8, 1.2).normalize();
  camera.position.copy(target).addScaledVector(dir, dist);
  camera.near = dist / 100;
  camera.far = dist * 100;
  camera.updateProjectionMatrix();
  camera.lookAt(target);
  return { target, size: box.getSize(new THREE.Vector3()) };
}
