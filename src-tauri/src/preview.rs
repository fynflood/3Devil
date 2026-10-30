//! Simplified copies of large binary STLs for thumbnails and the viewer.
//! Sending a 600 MB mesh to the webview is slow and can exhaust its memory;
//! a vertex-clustered copy looks the same at preview sizes.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufReader, Read};

/// Meshes at or below this many triangles are sent as-is.
const PASSTHROUGH_TRIANGLES: u32 = 150_000;

fn read_f32s<const N: usize>(buf: &[u8]) -> [f32; N] {
    std::array::from_fn(|i| f32::from_le_bytes(buf[i * 4..i * 4 + 4].try_into().unwrap()))
}

/// Returns `path` as a binary STL simplified onto a grid with `resolution`
/// cells along its longest side. Small meshes, ASCII STLs and other formats
/// are returned unchanged.
pub fn preview_bytes(path: &str, resolution: u32) -> std::io::Result<Vec<u8>> {
    let file = File::open(path)?;
    let len = file.metadata()?.len();
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let mut header = [0u8; 84];
    let is_stl = path.to_ascii_lowercase().ends_with(".stl");
    if !is_stl || len < 84 || reader.read_exact(&mut header).is_err() {
        return std::fs::read(path);
    }
    let count = u32::from_le_bytes(header[80..84].try_into().unwrap());
    let is_binary = len == 84 + 50 * count as u64;
    if !is_binary || count <= PASSTHROUGH_TRIANGLES {
        return std::fs::read(path);
    }

    // Pass 1: bounding box.
    let mut min = [f32::MAX; 3];
    let mut max = [f32::MIN; 3];
    let mut rec = [0u8; 50];
    for _ in 0..count {
        reader.read_exact(&mut rec)?;
        let v: [f32; 9] = read_f32s(&rec[12..48]);
        for k in 0..3 {
            for a in 0..3 {
                min[a] = min[a].min(v[k * 3 + a]);
                max[a] = max[a].max(v[k * 3 + a]);
            }
        }
    }
    let extent = (0..3).map(|a| max[a] - min[a]).fold(0f32, f32::max).max(1e-6);
    let cell = extent / resolution.max(8) as f32;
    let quant = |p: &[f32]| -> u64 {
        let q = |a: usize| (((p[a] - min[a]) / cell) as u64).min((1 << 21) - 1);
        q(0) | (q(1) << 21) | (q(2) << 42)
    };

    // Pass 2: merge vertices that share a grid cell (each merged vertex sits
    // at the mean of the originals, which keeps surfaces smooth), dropping
    // triangles that collapse or duplicate one already kept.
    let mut reader = BufReader::with_capacity(1 << 20, File::open(path)?);
    reader.read_exact(&mut header)?;
    let mut sums: HashMap<u64, [f64; 4]> = HashMap::new();
    let mut seen: HashSet<[u64; 3]> = HashSet::new();
    let mut kept: Vec<[u64; 3]> = Vec::new();
    for _ in 0..count {
        reader.read_exact(&mut rec)?;
        let v: [f32; 9] = read_f32s(&rec[12..48]);
        let keys = [quant(&v[0..3]), quant(&v[3..6]), quant(&v[6..9])];
        for (k, key) in keys.iter().enumerate() {
            let e = sums.entry(*key).or_insert([0.0; 4]);
            for a in 0..3 {
                e[a] += v[k * 3 + a] as f64;
            }
            e[3] += 1.0;
        }
        if keys[0] == keys[1] || keys[1] == keys[2] || keys[0] == keys[2] {
            continue;
        }
        let mut sorted = keys;
        sorted.sort_unstable();
        if seen.insert(sorted) {
            kept.push(keys);
        }
    }

    let mut out = Vec::with_capacity(84 + 50 * kept.len());
    out.extend_from_slice(&header[..80]);
    out.extend_from_slice(&(kept.len() as u32).to_le_bytes());
    for keys in kept {
        out.extend_from_slice(&[0u8; 12]); // normal: recomputed by the viewer
        for key in keys {
            let e = sums[&key];
            for a in 0..3 {
                out.extend_from_slice(&((e[a] / e[3]) as f32).to_le_bytes());
            }
        }
        out.extend_from_slice(&[0u8; 2]);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_grid_stl(path: &std::path::Path, n: usize) -> u32 {
        // A finely triangulated n×n square.
        let mut tris = Vec::new();
        for i in 0..n {
            for j in 0..n {
                let (x0, y0, x1, y1) = (i as f32, j as f32, i as f32 + 1.0, j as f32 + 1.0);
                tris.push([x0, y0, 0.0, x1, y0, 0.0, x1, y1, 0.0]);
                tris.push([x0, y0, 0.0, x1, y1, 0.0, x0, y1, 0.0]);
            }
        }
        let mut bytes = vec![0u8; 80];
        bytes.extend_from_slice(&(tris.len() as u32).to_le_bytes());
        for t in &tris {
            bytes.extend_from_slice(&[0u8; 12]);
            for f in t {
                bytes.extend_from_slice(&f.to_le_bytes());
            }
            bytes.extend_from_slice(&[0u8; 2]);
        }
        std::fs::write(path, bytes).unwrap();
        tris.len() as u32
    }

    #[test]
    fn large_mesh_is_simplified_and_valid() {
        let dir = std::env::temp_dir().join(format!("threedevil-preview-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("big.stl");
        let original = write_grid_stl(&path, 300); // 180k triangles
        let out = preview_bytes(path.to_str().unwrap(), 50).unwrap();
        let kept = u32::from_le_bytes(out[80..84].try_into().unwrap());
        assert!(kept > 1000 && kept < original / 10, "kept {kept} of {original}");
        assert_eq!(out.len(), 84 + 50 * kept as usize);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn small_mesh_is_returned_unchanged() {
        let dir = std::env::temp_dir().join(format!("threedevil-preview-small-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("small.stl");
        write_grid_stl(&path, 10);
        let out = preview_bytes(path.to_str().unwrap(), 50).unwrap();
        assert_eq!(out, std::fs::read(&path).unwrap());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
