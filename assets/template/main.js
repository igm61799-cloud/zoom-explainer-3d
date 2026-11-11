import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------- constants
const params = new URLSearchParams(location.search);
const W = 1920, H = 1080;
const SS = parseFloat(params.get('ss') || '1.5');
const RW = Math.round(W * SS), RH = Math.round(H * SS);
const FPS = 30;
const DEG = Math.PI / 180;

// physical data (metres)
const L0 = 22e-3;            // bar length at start = blade width (22 mm)
const RHO = 40e-9;           // edge tip radius (Roscioli et al., Science 2020)
const A1 = 8.5 * DEG;        // final facet half angle (17 deg wedge)
const A2 = 5.0 * DEG;        // second facet half angle
const D1 = 12e-6;            // depth where the second facet starts
const THK = 50e-6;           // half thickness of the blade body (0.1 mm blade)
const ATOM_D = 0.248e-9;     // nearest-neighbour distance in bcc iron
const LAT = 0.2866;          // bcc iron lattice constant, nm
const HMAX = Math.log2(L0 / 0.25e-9); // ~26.39 halvings -> bar = 0.250 nm

// timeline (seconds)
const T0 = 1.6, TZ = 40.0, T1 = T0 + TZ, TD = 2.6, T2 = T1 + TD, TO = 2.4, T3 = T2 + TO, TEND = 50.0;

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const smoother = u => u * u * u * (u * (u * 6 - 15) + 10);
function trap(u, r) {
  const v = 1 / (1 - r);
  if (u < r) return v * u * u / (2 * r);
  if (u < 1 - r) return v * (u - r / 2);
  return 1 - v * (1 - u) * (1 - u) / (2 * r);
}
function hAt(t) {
  if (t < T0) return 0;
  if (t < T1) return HMAX * trap((t - T0) / TZ, 0.07);
  if (t < T2) return HMAX;
  if (t < T3) return HMAX * (1 - smoother((t - T2) / TO));
  return 0;
}
function keyed(keys, h) {
  if (h <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (h <= keys[i][0]) {
      const u = smooth(keys[i - 1][0], keys[i][0], h);
      return keys[i - 1][1] + (keys[i][1] - keys[i - 1][1]) * u;
    }
  }
  return keys[keys.length - 1][1];
}
// camera keyframes as a function of the zoom level h
const K_AZ = [[0, 24], [3, 40], [6, 56], [12, 64], [16, 70], [18.6, 76], [21.5, 74], [HMAX, 62]];
const K_EL = [[0, 5], [3, 10], [6, 13], [12, 11], [16, 12], [18.6, 19], [21.5, 15], [HMAX, 17]];
const K_TY = [[0, -0.5], [3, -0.38], [6, -0.2], [HMAX, -0.2]];
const K_AP = [[0, 0.05], [2, 0.10], [6, 0.8], [15, 0.9], [17.5, 0.45], [20, 0.5], [22.5, 0.9], [HMAX, 1.0]];
const K_FOG = [[0, 9], [5, 9], [8, 6.5], [HMAX, 6.0]];
const K_D = [[0, 2.9], [4, 3.6], [HMAX, 3.6]];

// ---------------------------------------------------------------- renderer
const glCanvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(RW, RH, false);
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = THREE.NoToneMapping;

const out = document.getElementById('out');
out.width = W; out.height = H;
const ctx = out.getContext('2d');

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, W / H, 0.05, 300);

// ---------------------------------------------------------------- shared GLSL
const GLSL_COMMON = /* glsl */`
uniform float uFogR;
uniform float uFocus;
uniform float uAperture;
uniform vec3 uCamFwd;

float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float gnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*f*(f*(f*6.-15.)+10.);
  float a = dot(hash22(i)*2.-1., f);
  float b = dot(hash22(i+vec2(1,0))*2.-1., f-vec2(1,0));
  float c = dot(hash22(i+vec2(0,1))*2.-1., f-vec2(0,1));
  float d = dot(hash22(i+vec2(1,1))*2.-1., f-vec2(1,1));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y) * 1.6;
}
float lobe(vec3 r, vec3 d, float w, float s){ return exp(-(1. - dot(r, d)) / (w + s)); }
// analytic studio: a few soft boxes on black
vec3 envMap(vec3 r, float rough){
  float s = rough * rough * 1.6;
  vec3 c = vec3(0.012, 0.014, 0.019);
  c += vec3(1.00, 0.95, 0.88) * 1.50 * lobe(r, normalize(vec3(0.80, -0.22, -0.55)), 0.030, s);
  c += vec3(0.45, 0.70, 1.00) * 1.10 * lobe(r, normalize(vec3(0.45, -0.05, 0.89)), 0.020, s);
  c += vec3(1.00, 0.98, 0.95) * 1.50 * lobe(r, normalize(vec3(0.10, 1.00, 0.15)), 0.090, s);
  c += vec3(1.00, 0.55, 0.25) * 0.95 * lobe(r, normalize(vec3(-0.85, 0.35, -0.40)), 0.040, s);
  c += vec3(0.50, 0.72, 1.00) * 0.70 * lobe(r, normalize(vec3(0.30, 0.45, -0.84)), 0.018, s);
  c += vec3(1.00, 0.90, 0.80) * 0.55 * lobe(r, normalize(vec3(0.62, -0.62, 0.48)), 0.022, s);
  float el = asin(clamp(r.y, -1., 1.));
  c += vec3(0.8, 0.9, 1.0) * 0.30 * exp(-abs(el + 0.42) / (0.02 + s));
  c += vec3(0.045, 0.05, 0.06) * smoothstep(0.3, -0.9, r.y);
  return c;
}
vec3 diffEnv(vec3 n){
  vec3 c = vec3(0.05, 0.055, 0.07);
  c += vec3(1.00, 0.95, 0.88) * 0.75 * max(dot(n, normalize(vec3(0.80, 0.25, -0.55))), 0.);
  c += vec3(1.00, 0.98, 0.95) * 0.85 * max(dot(n, normalize(vec3(0.10, 1.00, 0.15))), 0.);
  c += vec3(0.50, 0.72, 1.00) * 0.35 * max(dot(n, normalize(vec3(0.45, 0.10, 0.89))), 0.);
  c += vec3(1.00, 0.58, 0.28) * 0.30 * max(dot(n, normalize(vec3(-0.85, 0.35, -0.40))), 0.);
  return c;
}
float fogF(vec3 wp){ float d = length(wp) / uFogR; return exp(-d*d); }
float cocF(vec3 wp){
  float z = dot(wp - cameraPosition, uCamFwd);
  return clamp(uAperture * abs(uFocus / max(z, 0.05) - 1.0), 0.0, 1.0);
}
`;

// ---------------------------------------------------------------- blade / wedge surface
const NU = 320, NZ = 400;
const SIG_MAX = 16, Z_MAX = 14;
const SIG = new Float64Array(NU + 1), ZS = new Float64Array(NZ + 1);
for (let k = 0; k <= NU; k++) SIG[k] = SIG_MAX * Math.pow(k / NU, 2.5);
for (let j = 0; j <= NZ; j++) { const u = j / NZ; ZS[j] = Z_MAX * (0.15 * u + 0.85 * u * u); }

const CU = 2 * NU + 1, CZ = 2 * NZ + 1;
const posArr = new Float32Array(CU * CZ * 3);
const nrmArr = new Float32Array(CU * CZ * 3);
const surfArr = new Float32Array(CU * CZ * 2);
for (let iu = 0; iu < CU; iu++) {
  const k = iu - NU, side = Math.sign(k), sg = SIG[Math.abs(k)];
  for (let iz = 0; iz < CZ; iz++) {
    const j = iz - NZ, z = Math.sign(j) * ZS[Math.abs(j)];
    const o = iu * CZ + iz;
    surfArr[o * 2] = side * sg; surfArr[o * 2 + 1] = z;
    posArr[o * 3 + 2] = z;
  }
}
const idx = new Uint32Array((CU - 1) * (CZ - 1) * 6);
{
  let q = 0;
  for (let iu = 0; iu < CU - 1; iu++) for (let iz = 0; iz < CZ - 1; iz++) {
    const a = iu * CZ + iz, b = a + 1, c = a + CZ, d = c + 1;
    idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d;
  }
}
const wedgeGeo = new THREE.BufferGeometry();
wedgeGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
wedgeGeo.setAttribute('normal', new THREE.BufferAttribute(nrmArr, 3));
wedgeGeo.setAttribute('aSurf', new THREE.BufferAttribute(surfArr, 2));
wedgeGeo.setIndex(new THREE.BufferAttribute(idx, 1));

// profile of the blade cross-section, parametrised by arclength from the apex (metres)
const capLen = RHO * (Math.PI / 2 - A1);
const capEnd = { x: RHO * Math.cos(A1), y: RHO * (1 - Math.sin(A1)) };
const seg1Len = (D1 - capEnd.y) / Math.cos(A1);
const p1 = { x: capEnd.x + (D1 - capEnd.y) * Math.tan(A1), y: D1 };
const seg2Len = (THK - p1.x) / Math.sin(A2);
const p2 = { x: THK, y: p1.y + (THK - p1.x) / Math.tan(A2) };
const BEVEL_LEN = capLen + seg1Len + seg2Len;
const profOut = [0, 0, 0, 0];
function prof(sig) {
  if (sig < capLen) {
    const a = sig / RHO, sh = Math.sin(a / 2);
    profOut[0] = RHO * Math.sin(a); profOut[1] = 2 * RHO * sh * sh; profOut[2] = Math.sin(a); profOut[3] = Math.cos(a);
    return;
  }
  sig -= capLen;
  if (sig < seg1Len) {
    profOut[0] = capEnd.x + sig * Math.sin(A1); profOut[1] = capEnd.y + sig * Math.cos(A1); profOut[2] = Math.cos(A1); profOut[3] = Math.sin(A1);
    return;
  }
  sig -= seg1Len;
  if (sig < seg2Len) {
    profOut[0] = p1.x + sig * Math.sin(A2); profOut[1] = p1.y + sig * Math.cos(A2); profOut[2] = Math.cos(A2); profOut[3] = Math.sin(A2);
    return;
  }
  sig -= seg2Len;
  profOut[0] = THK; profOut[1] = p2.y + sig; profOut[2] = 1; profOut[3] = 0;
}
const px_ = new Float64Array(NU + 1), py_ = new Float64Array(NU + 1), pnx = new Float64Array(NU + 1), pny = new Float64Array(NU + 1);
function updateWedge(h) {
  const s = Math.pow(2, h) / L0; // view units per metre
  for (let k = 0; k <= NU; k++) {
    prof(SIG[k] / s);
    px_[k] = profOut[0] * s; py_[k] = -profOut[1] * s; pnx[k] = profOut[2]; pny[k] = profOut[3];
  }
  for (let iu = 0; iu < CU; iu++) {
    const k = iu - NU, side = k < 0 ? -1 : 1, ak = Math.abs(k);
    const x = side * px_[ak], y = py_[ak], nx = side * pnx[ak], ny = pny[ak];
    let o = iu * CZ * 3;
    for (let iz = 0; iz < CZ; iz++, o += 3) {
      posArr[o] = x; posArr[o + 1] = y;
      nrmArr[o] = nx; nrmArr[o + 1] = ny;
    }
  }
  wedgeGeo.attributes.position.needsUpdate = true;
  wedgeGeo.attributes.normal.needsUpdate = true;
  return s;
}

const NF = 18, NC = 6;
const mkV4 = n => Array.from({ length: n }, () => new THREE.Vector4());
const sharedU = {
  uFogR: { value: 8 }, uFocus: { value: 3 }, uAperture: { value: 0.1 }, uCamFwd: { value: new THREE.Vector3() },
};
const wedgeU = {
  ...sharedU,
  uNF: { value: 0 }, uFeatA: { value: mkV4(NF) }, uFeatB: { value: mkV4(NF) },
  uChip: { value: mkV4(NC) },
  uCut: { value: 1 }, uMM: { value: 22 },
  uBevelEnd: { value: 1 },
  uGrain: { value: new THREE.Vector3() },   // freq, weight, seed
  uAtomTex: { value: new THREE.Vector2() }, // freq, weight
  uAtomScale: { value: 1 },                 // view units per nm
  uAtomIn: { value: 0 },                    // 0..1 real atoms present
  uAtomWin: { value: new THREE.Vector2(48, 34) },
};
const wedgeMat = new THREE.ShaderMaterial({
  uniforms: wedgeU,
  side: THREE.DoubleSide,
  vertexShader: /* glsl */`
    #define NC ${NC}
    attribute vec2 aSurf;
    uniform vec4 uChip[NC];
    uniform float uAtomScale, uAtomIn;
    uniform vec2 uAtomWin;
    varying vec2 vSurf; varying vec3 vWPos; varying vec3 vN; varying float vAtomMask;
    ${GLSL_COMMON}
    float chipV(float z, vec4 c){
      float n = gnoise(vec2(z * c.x + c.z * 13.7, c.z * 3.1));
      return 0.35 * n + 1.4 * pow(max(n - 0.22, 0.), 2.);
    }
    void main(){
      vec3 p = position;
      float sg = abs(aSurf.x);
      for(int i = 0; i < NC; i++){
        vec4 c = uChip[i];
        if(c.y <= 0.) continue;
        p.y -= c.y * (chipV(aSurf.y, c) - chipV(0., c)) * exp(-sg * c.w);
      }
      // sink the nominal surface where real atoms sit
      vec2 nm = vec2(aSurf.y, sg) / uAtomScale;
      float m = max(abs(nm.x) / uAtomWin.x, nm.y / uAtomWin.y);
      vAtomMask = uAtomIn * (1. - smoothstep(0.72, 1.0, m));
      p -= normal * vAtomMask * 0.42 * uAtomScale;
      vSurf = aSurf; vWPos = p; vN = normal;
      gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.);
    }`,
  fragmentShader: /* glsl */`
    #define NF ${NF}
    uniform int uNF;
    uniform vec4 uFeatA[NF]; uniform vec4 uFeatB[NF];
    uniform float uCut, uMM, uBevelEnd;
    uniform vec3 uGrain; uniform vec2 uAtomTex;
    varying vec2 vSurf; varying vec3 vWPos; varying vec3 vN; varying float vAtomMask;
    ${GLSL_COMMON}
    float sdBox(vec2 p, vec2 b, float r){ vec2 d = abs(p) - b + r; return length(max(d, 0.)) + min(max(d.x, d.y), 0.) - r; }
    float bladeSD(vec2 p){
      float o = min(sdBox(p, vec2(18.5, 11.0), 0.25), sdBox(p, vec2(21.5, 8.3), 0.9));
      float slot = sdBox(p, vec2(15.0, 1.15), 1.1);
      slot = min(slot, length(p) - 3.3);
      slot = min(slot, sdBox(vec2(abs(p.x) - 9.6, p.y), vec2(2.3, 2.3), 0.5));
      return max(o, -slot);
    }
    vec4 voro(vec2 x){
      vec2 n = floor(x), f = fract(x); float F1 = 8., F2 = 8.; vec2 id = vec2(0.), mr = vec2(0.);
      for(int j = -1; j <= 1; j++) for(int i = -1; i <= 1; i++){
        vec2 g = vec2(float(i), float(j)); vec2 o = hash22(n + g); vec2 r = g + o - f; float d = dot(r, r);
        if(d < F1){ F2 = F1; F1 = d; id = n + g; mr = r; } else if(d < F2){ F2 = d; }
      }
      return vec4(sqrt(F2) - sqrt(F1), mr, hash12(id + 3.7));
    }
    vec2 hexq(vec2 q){ q.x += 0.5 * mod(floor(q.y), 2.); return q; }
    vec2 Hf(vec2 p, float px, float sgn){
      float h = 0., cav = 0.;
      for(int i = 0; i < NF; i++){
        if(i >= uNF) break;
        vec4 A = uFeatA[i]; vec4 B = uFeatB[i];
        float f = A.x;
        float lodk = A.z > 2.5 ? 2.0 : (A.z > 1.5 ? 5.0 : 1.0);
        float w = A.y * (1. - smoothstep(0.16, 0.42, f * px * lodk));
        if(B.z > 0.5 && B.z < 1.5) w *= 1. - smoothstep(0.97, 1.0, sgn);
        if(B.z > 1.5) w *= smoothstep(0.97, 1.0, sgn);
        if(w < 1e-4) continue;
        vec2 so = vec2(A.w * 17.13, A.w * 7.77);
        float v;
        if(A.z < 0.5){
          vec2 q = p * f + so; v = gnoise(q) + 0.5 * gnoise(q * 2.03 + 5.3);
        } else if(A.z < 1.5){
          float c = cos(B.y), s = sin(B.y);
          vec2 q = vec2(c * p.x + s * p.y, -s * p.x + c * p.y) * f; q.x /= B.x; q += so;
          float n = gnoise(q);
          v = -pow(1. - abs(n), 6.) * 0.8 + 0.4 * gnoise(q * vec2(1., 3.1) + 9.);
        } else if(A.z < 2.5){
          vec4 vr = voro(p * f + so);
          v = (vr.w - 0.5) * 0.05 - dot(hash22(vec2(vr.w * 91.7, vr.w * 13.3)) - 0.5, vr.yz) * 0.42;
        } else {
          vec2 c = fract(hexq(p * f + so)) - 0.5;
          v = sqrt(max(0., 0.25 - dot(c, c))) * 1.6 - 0.4;
        }
        h += w * v / f; cav += w * v;
      }
      return vec2(h, cav);
    }
    void main(){
      vec2 p = vSurf;
      if(uCut > 0.5){
        float sd = bladeSD(vec2(p.y * uMM, -vWPos.y * uMM - 11.0));
        if(sd > 0.) discard;
      }
      float px = max(length(dFdx(p)), length(dFdy(p)));
      float e = max(px, 1e-6);
      float sgn = abs(p.x) / uBevelEnd;
      vec2 hc = Hf(p, px, sgn);
      float hs = Hf(p + vec2(e, 0.), px, sgn).x;
      float hz = Hf(p + vec2(0., e), px, sgn).x;
      float dHs = (hs - hc.x) / e, dHz = (hz - hc.x) / e;
      vec3 N = normalize(vN);
      if(!gl_FrontFacing) { /* keep attribute normal */ }
      vec3 T = vec3(N.y, -N.x, 0.); vec3 Bz = vec3(0., 0., 1.);
      vec3 n = normalize(N - dHs * T - dHz * Bz);
      vec3 V = normalize(cameraPosition - vWPos);
      float nv = dot(n, V);
      if(nv < 0.03) n = normalize(n + V * (0.03 - nv));
      float ndv = max(dot(n, V), 0.);
      vec3 R = reflect(-V, n);

      // steel
      vec3 F0 = vec3(0.56, 0.58, 0.62);
      float rough = 0.085;
      if(uGrain.y > 0.001){
        float gw = uGrain.y * (1. - smoothstep(0.16, 0.42, uGrain.x * px * 5.0));
        vec4 vr = voro(p * uGrain.x + vec2(uGrain.z * 17.13, uGrain.z * 7.77));
        vec3 tint = 0.5 + 0.5 * cos(6.2831 * (vr.w * 1.0 + vec3(0.0, 0.33, 0.67)));
        F0 *= mix(vec3(1.), (0.96 + 0.08 * tint) * (0.78 + 0.44 * vr.w), gw * 0.7);
        rough += gw * 0.12 * vr.w;
      }
      vec3 F = F0 + (1. - F0) * pow(1. - ndv, 5.);
      vec3 col = envMap(R, rough) * F;
      col *= mix(0.5, 1.15, smoothstep(-0.9, 0.7, hc.y * 2.2));

      // atom-like granular look once we are near the lattice scale
      if(uAtomTex.y > 0.001){
        float aw = uAtomTex.y;
        vec2 q = hexq(p * uAtomTex.x + vec2(4.1 * 17.13, 4.1 * 7.77));
        float id = hash12(floor(q) + 11.);
        vec3 ac = id < 0.13 ? vec3(0.08, 0.58, 0.78) : vec3(1.0, 0.36, 0.07);
        ac *= 0.8 + 0.4 * hash12(floor(q) + 23.);
        ac *= mix(0.55, 1.0, smoothstep(0.5, 0.30, length(fract(q) - 0.5)));
        float lod = 1. - smoothstep(0.16, 0.42, uAtomTex.x * px * 2.0);
        ac = mix(vec3(0.72, 0.33, 0.12), ac, lod);
        vec3 colA = ac * diffEnv(n) * 0.36 + envMap(R, 0.35) * (0.04 + 0.10 * pow(1. - ndv, 4.));
        col = mix(col, colA, aw);
      }
      col *= 1. - 0.93 * vAtomMask;

      col *= fogF(vWPos);
      gl_FragColor = vec4(col, cocF(vWPos));
    }`,
});
const wedge = new THREE.Mesh(wedgeGeo, wedgeMat);
wedge.frustumCulled = false;
scene.add(wedge);

// physical surface features: wavelength (m), type, slope amplitude, stretch, angle, flag, seed
// type 0 isotropic, 1 lines, 2 grains, 3 atom bumps ; flag 1 = bevel only, 2 = body only
const FEATS = [];
[[1.4e-3, 0.006], [0.45e-3, 0.009], [0.14e-3, 0.010]].forEach(([l, a], i) => FEATS.push({ lam: l, type: 1, amp: a, stretch: 60, ang: Math.PI / 2 + 0.015 * i, flag: 2, seed: 40 + i }));
[[110e-6, 0.050, 0.10], [40e-6, 0.060, -0.16], [14e-6, 0.065, 0.06], [5e-6, 0.070, -0.10], [1.8e-6, 0.065, 0.14], [0.65e-6, 0.055, -0.06], [0.24e-6, 0.04, 0.09]]
  .forEach(([l, a, g], i) => FEATS.push({ lam: l, type: 1, amp: a, stretch: 28, ang: g, flag: 1, seed: 1 + i }));
for (let n = 9; n <= 25; n += 2) FEATS.push({ lam: L0 / Math.pow(2, n) * 3.0, type: 0, amp: n >= 19 ? 0.10 : (n >= 13 ? 0.06 : 0.007), stretch: 1, ang: 0, flag: 0, seed: 60 + n });
const F_GRAIN = { lam: 0.5e-6, type: 2, amp: 0.30, stretch: 1, ang: 0, flag: 0, seed: 90 };
FEATS.push(F_GRAIN);
const F_ATOM = { lam: ATOM_D, type: 3, amp: 0.55, stretch: 1, ang: 0, flag: 0, seed: 4.1 };
FEATS.push(F_ATOM);
// edge chipping: wavelength (m), depth as a fraction of the wavelength
const CHIPS = [[400e-6, 0.010], [45e-6, 0.03], [7e-6, 0.09], [1.6e-6, 0.11], [0.35e-6, 0.07], [70e-9, 0.04]];

function updateFeatures(h) {
  const zoom = Math.pow(2, h);
  let n = 0;
  wedgeU.uGrain.value.set(0, 0, 0);
  for (const F of FEATS) {
    const f = (L0 / F.lam) / zoom;
    if (f > 900 || f < 0.06) continue;
    let w = smooth(0.07, 0.45, f);
    if (F === F_ATOM) w = 1.0 - smooth(1.2, 0.5, f) * 0.0; // atoms never fade out, they are replaced by real spheres
    if (F.type === 0 && h > 20) w *= 1 - smooth(20, 21.5, h);
    if (F.type === 1 && h > 19.5) w *= 1 - smooth(19.5, 21, h);
    if (F === F_GRAIN) { w *= (1 - smooth(19.0, 20.5, h)) * smooth(11.0, 12.6, h); wedgeU.uGrain.value.set(f, w, F.seed); }
    if (w < 1e-3 || n >= NF) continue;
    wedgeU.uFeatA.value[n].set(f, F.amp * w, F.type, F.seed);
    wedgeU.uFeatB.value[n].set(F.stretch, F.ang, F.flag, 0);
    n++;
  }
  wedgeU.uNF.value = n;
  // atom texture
  const fa = (L0 / ATOM_D) / zoom;
  wedgeU.uAtomTex.value.set(fa, smooth(19.5, 20.6, h));
  // chips
  for (let i = 0; i < NC; i++) {
    const [lam, dep] = CHIPS[i];
    const f = (L0 / lam) / zoom;
    let w = smooth(0.02, 0.12, f) * (1 - smooth(3.0, 7.0, f));
    w *= 1 - smooth(19, 21, h);
    wedgeU.uChip.value[i].set(f, w * dep / f, i + 1, f * 0.9);
  }
}

// ---------------------------------------------------------------- atoms (sphere impostors)
function buildAtoms() {
  const ZW = 48, SW = 34, SHELL = 0.62, R0 = 0.124;
  const rho = RHO * 1e9; // nm
  // lattice orientation
  const e = new THREE.Euler(0.21, 0.47, 0.13);
  const m = new THREE.Matrix4().makeRotationFromEuler(e).elements;
  const maxR = Math.sqrt(31 * 31 + 15 * 15 + 49 * 49);
  const n = Math.ceil(maxR / LAT) + 1;
  const sA = Math.sin(A1), cA = Math.cos(A1);
  const centers = [], info = [];
  let rnd = 1234567;
  const rand = () => { rnd = (rnd * 1664525 + 1013904223) >>> 0; return rnd / 4294967296; };
  const basis = [[0, 0, 0], [0.5, 0.5, 0.5]];
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) for (let k = -n; k <= n; k++) for (let b = 0; b < 2; b++) {
    const lx = (i + basis[b][0]) * LAT, ly = (j + basis[b][1]) * LAT, lz = (k + basis[b][2]) * LAT;
    const y = m[1] * lx + m[5] * ly + m[9] * lz;
    if (y > 0.2 || y < -15) continue;
    const z = m[2] * lx + m[6] * ly + m[10] * lz;
    if (z > ZW || z < -ZW) continue;
    const x = m[0] * lx + m[4] * ly + m[8] * lz;
    if (x > 31 || x < -31) continue;
    // signed depth below the rounded wedge surface
    const qx = Math.abs(x), qy = -rho - y; // relative to the cap centre, qy > 0 is deeper
    let dist;
    if (qx < qy * Math.tan(A1)) dist = 0;
    else { const pr = qx * sA + qy * cA; dist = pr < 0 ? Math.hypot(qx, qy) : Math.abs(qx * cA - qy * sA); }
    const d = rho - dist;
    if (d < R0 || d > SHELL) continue;
    const s = rho * Math.atan2(qx, -qy);
    const mm = Math.max(Math.abs(z) / ZW, s / SW);
    if (mm >= 1) continue;
    const depth = (d - R0) / (SHELL - R0);
    if (depth < 0.25 && rand() < 0.03) continue; // a few vacancies
    centers.push(x, y, z);
    info.push(rand() < 0.13 ? 1 : 0, depth, 1 - smooth(0.72, 1.0, mm), rand());
  }
  // put the highest atom near the focus exactly under the bar
  let best = -1, by = -1e9;
  for (let a = 0; a < centers.length; a += 3) {
    if (Math.abs(centers[a]) < 0.35 && Math.abs(centers[a + 2]) < 0.35 && centers[a + 1] > by) { by = centers[a + 1]; best = a; }
  }
  const ox = centers[best], oy = centers[best + 1] + R0, oz = centers[best + 2];
  for (let a = 0; a < centers.length; a += 3) { centers[a] -= ox; centers[a + 1] -= oy; centers[a + 2] -= oz; }
  info[(best / 3) * 4] = 0; // the atom under the bar is iron
  return { centers: new Float32Array(centers), info: new Float32Array(info), count: centers.length / 3 };
}
const atomsData = buildAtoms();
const atomGeo = new THREE.InstancedBufferGeometry();
atomGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
atomGeo.setIndex([0, 1, 2, 0, 2, 3]);
atomGeo.setAttribute('aCenter', new THREE.InstancedBufferAttribute(atomsData.centers, 3));
atomGeo.setAttribute('aInfo', new THREE.InstancedBufferAttribute(atomsData.info, 4));
atomGeo.instanceCount = atomsData.count;
const atomU = { ...sharedU, uAtomScale: { value: 1 }, uGrow: { value: 0 }, uCamWorld: { value: new THREE.Matrix4() } };
const atomMat = new THREE.ShaderMaterial({
  uniforms: atomU,
  vertexShader: /* glsl */`
    attribute vec3 aCenter; attribute vec4 aInfo;
    uniform float uAtomScale, uGrow;
    varying vec3 vC; varying float vR; varying vec3 vVP; varying vec4 vInfo;
    void main(){
      vec4 cv = viewMatrix * vec4(aCenter * uAtomScale, 1.);
      float r = 0.134 * uAtomScale * uGrow * aInfo.z;
      vC = cv.xyz; vR = r; vInfo = aInfo;
      vec3 vp = cv.xyz + vec3(position.xy * r * 1.6, 0.);
      vVP = vp;
      gl_Position = projectionMatrix * vec4(vp, 1.);
    }`,
  fragmentShader: /* glsl */`
    uniform mat4 uCamWorld; uniform mat4 projectionMatrix;
    varying vec3 vC; varying float vR; varying vec3 vVP; varying vec4 vInfo;
    ${GLSL_COMMON}
    void main(){
      if(vR <= 0.) discard;
      vec3 rd = normalize(vVP);
      float b = dot(rd, vC); float c = dot(vC, vC) - vR * vR; float disc = b * b - c;
      if(disc < 0.) discard;
      float t = b - sqrt(disc);
      vec3 ph = rd * t;
      vec3 nV = (ph - vC) / vR;
      vec4 clip = projectionMatrix * vec4(ph, 1.);
      gl_FragDepth = clip.z / clip.w * 0.5 + 0.5;
      vec3 n = normalize(mat3(uCamWorld) * nV);
      vec3 wp = (uCamWorld * vec4(ph, 1.)).xyz;
      vec3 V = normalize(cameraPosition - wp);
      float ndv = max(dot(n, V), 0.);
      vec3 R = reflect(-V, n);
      vec3 base = vInfo.x > 0.5 ? vec3(0.07, 0.58, 0.80) : vec3(1.0, 0.36, 0.06);
      base *= 0.82 + 0.36 * vInfo.w;
      vec3 col = base * diffEnv(n) * 0.5;
      col += envMap(R, 0.22) * (0.035 + 0.55 * pow(1. - ndv, 4.));
      // buried atoms and contact shadows
      col *= mix(1.0, 0.16, smoothstep(0.0, 0.9, vInfo.y));
      col *= 0.45 + 0.55 * smoothstep(-0.75, 0.35, n.y + 0.35 * ndv);
      col *= fogF(wp);
      gl_FragColor = vec4(col, cocF(wp));
    }`,
});
const atoms = new THREE.Mesh(atomGeo, atomMat);
atoms.frustumCulled = false;
scene.add(atoms);

// ---------------------------------------------------------------- dust that streams past as we zoom
const NDUST = 240;
const dustDir = new Float32Array(NDUST * 3), dustPh = new Float32Array(NDUST), dustPos = new Float32Array(NDUST * 3), dustA = new Float32Array(NDUST);
{
  let s = 99991;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < NDUST; i++) {
    const u = rand() * 2 - 1, a = rand() * Math.PI * 2, r = Math.sqrt(1 - u * u);
    dustDir[i * 3] = r * Math.cos(a); dustDir[i * 3 + 1] = Math.abs(u) * 0.9 + 0.03; dustDir[i * 3 + 2] = r * Math.sin(a);
    dustPh[i] = rand();
  }
}
const dustGeo = new THREE.BufferGeometry();
dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
dustGeo.setAttribute('aA', new THREE.BufferAttribute(dustA, 1));
const dustU = { ...sharedU, uPx: { value: RH }, uDust: { value: 1 } };
const dustMat = new THREE.ShaderMaterial({
  uniforms: dustU, transparent: true, depthWrite: false,
  blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  vertexShader: /* glsl */`
    attribute float aA; uniform float uPx, uDust; varying float vI;
    ${GLSL_COMMON}
    void main(){
      vec4 mv = viewMatrix * vec4(position, 1.);
      float coc = cocF(position);
      float size = uPx * (0.0016 + 0.017 * coc);
      gl_PointSize = size;
      vI = aA * uDust * fogF(position) * (uPx * 0.0016) * (uPx * 0.0016) / (size * size) * 2.2;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    varying float vI;
    void main(){
      float d = length(gl_PointCoord - 0.5);
      float a = 1. - smoothstep(0.38, 0.5, d);
      gl_FragColor = vec4(vec3(0.85, 0.92, 1.0) * vI * a, 0.);
    }`,
});
const dust = new THREE.Points(dustGeo, dustMat);
dust.frustumCulled = false;
scene.add(dust);
const DUST_K = Math.log2(14 / 0.5);
function updateDust(h) {
  for (let i = 0; i < NDUST; i++) {
    const u = ((dustPh[i] * DUST_K + h) % DUST_K) / DUST_K;
    const r = 0.5 * Math.pow(2, u * DUST_K);
    dustPos[i * 3] = dustDir[i * 3] * r; dustPos[i * 3 + 1] = dustDir[i * 3 + 1] * r - 0.02; dustPos[i * 3 + 2] = dustDir[i * 3 + 2] * r;
    dustA[i] = Math.sin(Math.PI * u) ** 0.7;
  }
  dustGeo.attributes.position.needsUpdate = true;
  dustGeo.attributes.aA.needsUpdate = true;
}

// ---------------------------------------------------------------- things for scale
// Every object is anchored at a real physical position on the edge, so the zoom itself
// makes it grow, slide outwards and leave the frame. Geometry is modelled with size 1.
function tint(geo, r, g, b) {
  const n = geo.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = r; a[i * 3 + 1] = g; a[i * 3 + 2] = b; }
  geo.setAttribute('aCol', new THREE.BufferAttribute(a, 3));
  return geo;
}
function objMat(kind = 0, gloss = 1, emis = 0) {
  return new THREE.ShaderMaterial({
    uniforms: { ...sharedU, uKind: { value: kind }, uGloss: { value: gloss }, uEmis: { value: emis } },
    vertexShader: /* glsl */`
      attribute vec3 aCol;
      varying vec3 vWPos; varying vec3 vN; varying vec3 vCol; varying vec3 vObj;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.);
        vWPos = wp.xyz; vN = normalize(mat3(modelMatrix) * normal); vCol = aCol; vObj = position;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      uniform float uKind, uGloss, uEmis;
      varying vec3 vWPos; varying vec3 vN; varying vec3 vCol; varying vec3 vObj;
      ${GLSL_COMMON}
      void main(){
        vec3 n = normalize(vN);
        vec3 V = normalize(cameraPosition - vWPos);
        if(dot(n, V) < 0.) n = -n;
        vec3 base = vCol;
        if(uKind > 0.5 && uKind < 1.5){
          // hair cuticle: overlapping scales along the shaft
          float ang = atan(vObj.z, vObj.y) / 6.2831853;
          vec2 q = vec2(ang * 16., vObj.x * 5.0);
          float ci = floor(q.x);
          q.y += hash12(vec2(ci, 3.)) * 1.0 + 0.35 * gnoise(vec2(q.x * 0.7, q.y * 0.3));
          float fy = fract(q.y);
          base *= mix(0.45, 1.0, smoothstep(0.0, 0.16, fy)) * (0.8 + 0.4 * hash12(vec2(ci, floor(q.y))));
          n = normalize(n + vec3((fy - 0.5) * 0.45, 0., 0.));
        } else if(uKind > 1.5){
          // soft organic mottling
          base *= 0.82 + 0.3 * gnoise(vObj.xy * 9. + vObj.z * 7.);
          n = normalize(n + 0.18 * vec3(gnoise(vObj.yz * 14.), gnoise(vObj.zx * 14. + 3.), gnoise(vObj.xy * 14. + 7.)));
        }
        float ndv = max(dot(n, V), 0.);
        vec3 R = reflect(-V, n);
        vec3 col = base * (diffEnv(n) * 0.52 + 0.035);
        col += envMap(R, 0.3) * uGloss * (0.05 + 0.6 * pow(1. - ndv, 4.));
        col += base * uEmis * (0.6 + 0.8 * pow(1. - ndv, 2.));
        col *= fogF(vWPos);
        gl_FragColor = vec4(col, cocF(vWPos));
      }`,
  });
}
const OBJS = [];
function addObj(name, sizeText, D, geo, mat, opt = {}) {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; mesh.visible = false;
  if (opt.rot) mesh.rotation.set(...opt.rot);
  scene.add(mesh);
  OBJS.push({ name, sizeText, D, mesh, k: opt.k ?? 2.0, y: opt.y ?? 0.5, x: opt.x ?? 0, top: opt.top ?? 0.6, spin: opt.spin ?? null, rot0: opt.rot ?? [0, 0, 0] });
}
{
  // grain of salt, 0.3 mm cube
  addObj('grain of salt', '0.3 mm', 300e-6, tint(new THREE.BoxGeometry(1, 1, 1), 0.86, 0.90, 0.95), objMat(0, 2.2), { rot: [0.55, 0.62, 0.2], y: 0.78, k: 2.1, top: 0.95 });
  // human hair, 80 um thick, lying across the edge
  addObj('human hair', '80 µm', 80e-6, tint(new THREE.CylinderGeometry(0.5, 0.5, 70, 64, 400, true).rotateZ(Math.PI / 2), 0.26, 0.14, 0.07), objMat(1, 1.4), { rot: [0, 0.22, 0.05], y: 0.5, k: 2.3, top: 0.75 });
  // red blood cell, 8 um biconcave disc
  {
    const pts = [];
    const zf = r => 0.5 * Math.sqrt(Math.max(0, 1 - r * r)) * (0.207 + 2.003 * r * r - 1.123 * r * r * r * r) * 0.5;
    for (let i = 0; i <= 40; i++) { const r = i / 40; pts.push(new THREE.Vector2(r * 0.5, zf(r))); }
    for (let i = 39; i >= 0; i--) { const r = i / 40; pts.push(new THREE.Vector2(r * 0.5, -zf(r))); }
    addObj('red blood cell', '8 µm', 7.8e-6, tint(new THREE.LatheGeometry(pts, 72), 0.72, 0.06, 0.05), objMat(0, 1.0), { rot: [1.05, 0.3, 0.35], x: 0.5, y: 0.75, k: 1.6, top: 0.55, spin: [0.0, 0.25, 0.0] });
  }
  // E. coli, 2 um long
  addObj('bacterium', '2 µm', 2e-6, tint(new THREE.CapsuleGeometry(0.13, 0.74, 16, 40).rotateX(Math.PI / 2), 0.38, 0.62, 0.30), objMat(2, 0.8), { rot: [0, 1.25, 0], y: 0.13, k: 2.0, top: 0.3 });
  // one wavelength of green light, 550 nm
  {
    class Wave extends THREE.Curve { getPoint(t, o = new THREE.Vector3()) { return o.set(0, 0.22 * Math.sin(t * Math.PI * 2 * 3), (t - 0.5) * 3); } }
    addObj('wave of green light', '550 nm', 550e-9, tint(new THREE.TubeGeometry(new Wave(), 240, 0.035, 12, false), 0.25, 1.0, 0.35), objMat(0, 0.2, 2.6), { rot: [0, 1.3, 0], x: 0.4, y: 0.85, k: 2.6, top: 0.42 });
  }
  // virus, 100 nm
  {
    const parts = [tint(new THREE.SphereGeometry(0.4, 48, 32), 0.50, 0.46, 0.60)];
    for (let i = 0; i < 70; i++) {
      const u = 1 - 2 * (i + 0.5) / 70, a = i * 2.39996323, r = Math.sqrt(1 - u * u);
      const d = new THREE.Vector3(r * Math.cos(a), u, r * Math.sin(a));
      const stalk = tint(new THREE.CylinderGeometry(0.018, 0.022, 0.09, 8), 0.75, 0.25, 0.28);
      stalk.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d)).translate(d.x * 0.43, d.y * 0.43, d.z * 0.43);
      const knob = tint(new THREE.SphereGeometry(0.038, 12, 8), 0.90, 0.22, 0.26).translate(d.x * 0.48, d.y * 0.48, d.z * 0.48);
      parts.push(stalk, knob);
    }
    addObj('virus', '100 nm', 100e-9, mergeGeometries(parts), objMat(2, 0.9), { x: 1.0, y: 0.6, k: 1.5, top: 0.6, spin: [0, 0.2, 0] });
  }
  // FinFET transistor, ~50 nm footprint
  {
    const parts = [tint(new THREE.BoxGeometry(1.25, 0.1, 1.0), 0.10, 0.13, 0.20).translate(0, 0.05, 0)];
    for (const fx of [-0.42, 0, 0.42]) parts.push(tint(new THREE.BoxGeometry(0.13, 0.5, 1.0), 0.55, 0.62, 0.72).translate(fx, 0.35, 0));
    parts.push(tint(new THREE.BoxGeometry(1.25, 0.66, 0.34), 0.95, 0.62, 0.20).translate(0, 0.43, 0));
    parts.push(tint(new THREE.BoxGeometry(1.25, 0.05, 0.42), 0.20, 0.65, 0.75).translate(0, 0.785, 0));
    addObj('chip transistor', '50 nm', 50e-9, mergeGeometries(parts), objMat(0, 1.8), { rot: [0, 0.5, 0], y: 0.0, k: 2.3, top: 0.95 });
  }
  // antibody, ~12 nm Y
  {
    const arm = (ang, len) => tint(new THREE.CapsuleGeometry(0.12, len, 8, 20).translate(0, len / 2 + 0.06, 0).rotateZ(ang), 0.92, 0.72, 0.25);
    addObj('antibody', '12 nm', 12e-9, mergeGeometries([arm(Math.PI, 0.38), arm(0.9, 0.36), arm(-0.9, 0.36)]), objMat(2, 0.7), { rot: [0.1, 0.5, 0.1], x: 0.9, y: 0.75, k: 1.5, top: 0.6, spin: [0, 0.3, 0] });
  }
  // DNA double helix, 2 nm wide
  {
    const LEN = 7, PITCH = 1.7, RAD = 0.5;
    class Helix extends THREE.Curve {
      constructor(ph) { super(); this.ph = ph; }
      getPoint(t, o = new THREE.Vector3()) { const z = (t - 0.5) * LEN, a = z / PITCH * Math.PI * 2 + this.ph; return o.set(RAD * Math.cos(a), RAD * Math.sin(a), z); }
    }
    const parts = [
      tint(new THREE.TubeGeometry(new Helix(0), 300, 0.085, 10, false), 0.22, 0.45, 0.95),
      tint(new THREE.TubeGeometry(new Helix(2.3), 300, 0.085, 10, false), 0.22, 0.45, 0.95),
    ];
    for (let z = -LEN / 2 + 0.1; z < LEN / 2; z += 0.17) {
      const a = z / PITCH * Math.PI * 2, a2 = a + 2.3;
      const p1 = new THREE.Vector3(RAD * Math.cos(a), RAD * Math.sin(a), z), p2 = new THREE.Vector3(RAD * Math.cos(a2), RAD * Math.sin(a2), z);
      const d = p2.clone().sub(p1), len = d.length();
      const rung = tint(new THREE.CylinderGeometry(0.035, 0.035, len, 6), 0.90, 0.90, 0.96);
      rung.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize())).translate((p1.x + p2.x) / 2, (p1.y + p2.y) / 2, z);
      parts.push(rung);
    }
    addObj('DNA', '2 nm', 2e-9, mergeGeometries(parts), objMat(0, 1.0), { rot: [0, 1.2, 0], y: 0.62, k: 2.6, top: 0.75 });
  }
}
function updateObjs(s, t) {
  for (const o of OBJS) {
    const v = o.D * s;
    const vis = v > 0.02 && v < 14;
    o.mesh.visible = vis; o.v = v;
    if (!vis) continue;
    const g = smooth(0.02, 0.07, v);
    o.mesh.scale.setScalar(v * g);
    o.mesh.position.set(o.x * v, o.y * v * g, -o.k * v);
    if (o.spin) o.mesh.rotation.set(o.rot0[0] + o.spin[0] * t, o.rot0[1] + o.spin[1] * t, o.rot0[2] + o.spin[2] * t);
  }
}
function drawTags(t) {
  const aT = 1 - smooth(T2 - 0.1, T2 + 0.3, t);
  if (aT < 0.01) return;
  for (const o of OBJS) {
    if (!o.mesh.visible) continue;
    const a = smooth(0.17, 0.26, o.v) * (1 - smooth(0.8, 1.1, o.v)) * aT;
    if (a < 0.01) continue;
    const p = o.mesh.position;
    const [x, y] = project(p.x, p.y + o.top * o.v, p.z);
    if (x < -200 || x > W + 200) continue;
    const yy = Math.max(y - 18, 74);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 10;
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.font = `600 30px ${FONT}`;
    ctx.fillText(o.name, x, yy - 30);
    ctx.font = `400 24px ${FONT}`;
    ctx.globalAlpha = a * 0.85;
    ctx.fillText(o.sizeText, x, yy);
    ctx.restore();
  }
}

// ---------------------------------------------------------------- post
const rt = new THREE.WebGLRenderTarget(RW, RH, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, rt);
composer.setPixelRatio(1);
composer.setSize(RW, RH);
composer.addPass(new RenderPass(scene, camera, null, new THREE.Color(0x000000), 0));
const dofPass = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uRes: { value: new THREE.Vector2(RW, RH) }, uMaxR: { value: RH * 0.024 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform vec2 uRes; uniform float uMaxR; varying vec2 vUv;
    float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    void main(){
      vec4 c0 = texture2D(tDiffuse, vUv);
      vec3 acc = c0.rgb;
      float rot = h12(gl_FragCoord.xy) * 6.2831853;
      const int N = 72;
      for(int i = 0; i < N; i++){
        float fi = float(i) + 0.5;
        float r = sqrt(fi / float(N)) * uMaxR;
        float a = fi * 2.39996323 + rot;
        vec4 s = texture2D(tDiffuse, vUv + vec2(cos(a), sin(a)) * r / uRes);
        float cov = smoothstep(r - 1.5, r + 1.5, s.a * uMaxR);
        acc += mix(c0.rgb, s.rgb, cov);
      }
      gl_FragColor = vec4(acc / float(N + 1), c0.a);
    }`,
});
composer.addPass(dofPass);
const bloom = new UnrealBloomPass(new THREE.Vector2(RW, RH), 0.28, 0.75, 0.85);
composer.addPass(bloom);
const finalPass = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uFrame: { value: 0 }, uSS: { value: SS }, uExp: { value: 1.0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float uFrame, uSS, uExp; varying vec2 vUv;
    float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0., 1.); }
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb * uExp;
      vec2 d = vUv - 0.5;
      c *= 1. - 0.55 * smoothstep(0.25, 0.95, length(d * vec2(1.0, 0.8)) * 1.35);
      c = aces(c);
      c = pow(c, vec3(1. / 2.2));
      float g = h12(floor(gl_FragCoord.xy / uSS) + uFrame * 17.31) - 0.5;
      c += g * 0.018 * (0.5 + 0.5 * (1. - dot(c, vec3(0.333))));
      gl_FragColor = vec4(c, 1.);
    }`,
});
composer.addPass(finalPass);

// ---------------------------------------------------------------- overlay (bar + numbers)
const LABELS = [
  [-1, 2.6, 'razor blade'],
  [2.6, 6.0, 'the bevel'],
  [6.0, 10.2, 'grinding marks'],
  [10.2, 12.7, 'micro-chips in the edge'],
  [12.7, 16.6, 'grains of steel'],
  [16.6, 19.6, 'the cutting edge'],
  [19.6, 22.6, 'crystal lattice'],
  [22.6, 25.75, 'iron atoms'],
  [25.75, 99, 'one iron atom'],
];
function fmt(v) {
  if (v >= 1e-2) return (v * 100).toFixed(2) + ' cm';
  if (v >= 1e-3) return (v * 1e3).toPrecision(3) + ' mm';
  if (v >= 1e-6) return (v * 1e6).toPrecision(3) + ' µm';
  if (v >= 1e-9) return (v * 1e9).toPrecision(3) + ' nm';
  return (v * 1e9).toFixed(3) + ' nm';
}
const FONT = '"Segoe UI", "Helvetica Neue", Arial, sans-serif';
const v3 = new THREE.Vector3();
function project(x, y, z) {
  v3.set(x, y, z).project(camera);
  return [(v3.x * 0.5 + 0.5) * W, (1 - (v3.y * 0.5 + 0.5)) * H];
}
function drawOverlay(t, h) {
  const aBar = smooth(0.35, 1.0, t) * (1 - smooth(T2 - 0.1, T2 + 0.3, t));
  if (aBar > 0.002) {
    const [x0, y0] = project(0, 0, 0), [x1, y1] = project(0, -1, 0);
    ctx.save();
    ctx.globalAlpha = aBar;
    ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 10;
    ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fff'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    for (const [x, y] of [[x0, y0], [x1, y1]]) { ctx.beginPath(); ctx.moveTo(x - 7, y); ctx.lineTo(x + 7, y); ctx.stroke(); }
    const tx = Math.min(x0, x1) - 26, ty = y0 - 92;
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'right';
    ctx.font = `600 50px ${FONT}`;
    ctx.fillText(fmt(L0 / Math.pow(2, h)), tx, ty);
    ctx.font = `400 25px ${FONT}`;
    ctx.globalAlpha = aBar * 0.92;
    const n = Math.floor(h + 1e-6);
    ctx.fillText(`halved ${n} time${n === 1 ? '' : 's'}`, tx - 1, ty + 36);
    for (const [a, b, txt] of LABELS) {
      const al = smooth(a - 0.12, a + 0.12, h) * (1 - smooth(b - 0.12, b + 0.12, h));
      if (al < 0.01) continue;
      ctx.globalAlpha = aBar * 0.92 * al;
      ctx.fillText(txt, tx - 1, ty + 69);
    }
    ctx.restore();
  }
  const aCap = smooth(T3 + 0.25, T3 + 0.95, t);
  if (aCap > 0.002) {
    const [x0, y0] = project(0, 0, 0);
    ctx.save();
    ctx.globalAlpha = aCap;
    ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fff'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(x0, y0 - 8); ctx.lineTo(x0, y0 - 64); ctx.stroke();
    ctx.beginPath(); ctx.arc(x0, y0 - 4, 3.2, 0, Math.PI * 2); ctx.fill();
    ctx.font = `600 40px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('its edge: about 300 atoms wide', x0, y0 - 84);
    ctx.restore();
  }
}

// ---------------------------------------------------------------- frame
const fwd = new THREE.Vector3();
function renderScene(t, frameNo) {
  const h = hAt(t);
  const s = updateWedge(h);
  updateFeatures(h);
  updateDust(h);
  updateObjs(s, t);
  const mm = 22 / Math.pow(2, h);
  wedgeU.uCut.value = h < 7.5 ? 1 : 0;
  wedgeU.uMM.value = mm;
  wedgeU.uBevelEnd.value = BEVEL_LEN * s;
  const atomScale = s * 1e-9; // view units per nm
  wedgeU.uAtomScale.value = atomScale; atomU.uAtomScale.value = atomScale;
  const grow = smooth(20.1, 21.3, h);
  wedgeU.uAtomIn.value = grow; atomU.uGrow.value = grow;
  atoms.visible = grow > 0.001;

  const drift = t;
  const az = (keyed(K_AZ, h) + 2.5 * Math.sin(drift * 0.23) + (t >= T1 ? 9 * smooth(T1, T2, t) * (t < T2 ? 1 : 1 - smooth(T2, T3, t)) : 0)) * DEG;
  const el = (keyed(K_EL, h) + 1.0 * Math.sin(drift * 0.17 + 1.0)) * DEG;
  const ty = keyed(K_TY, h), CAM_D = keyed(K_D, h);
  camera.position.set(CAM_D * Math.cos(el) * Math.cos(az), ty + CAM_D * Math.sin(el), CAM_D * Math.cos(el) * Math.sin(az));
  camera.lookAt(0, ty, 0);
  camera.updateMatrixWorld(true);
  camera.getWorldDirection(fwd);
  sharedU.uCamFwd.value.copy(fwd);
  sharedU.uFocus.value = fwd.dot(v3.set(0, -0.3, 0).sub(camera.position));
  sharedU.uAperture.value = keyed(K_AP, h);
  sharedU.uFogR.value = keyed(K_FOG, h);
  atomU.uCamWorld.value.copy(camera.matrixWorld);
  dustU.uDust.value = smooth(1.5, 5, h);
  finalPass.uniforms.uFrame.value = frameNo;
  composer.render();
  return h;
}
function drawFrame(t) {
  const frameNo = Math.round(t * FPS);
  ctx.globalAlpha = 1;
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  let h;
  if (t > T2 && t < T3) {
    // motion blur for the fast pull-back
    const K = 10;
    for (let k = 0; k < K; k++) {
      h = renderScene(t + (k / K - 0.5) / FPS * 0.9, frameNo * 16 + k);
      ctx.globalAlpha = 1 / (k + 1);
      ctx.drawImage(glCanvas, 0, 0, W, H);
    }
    ctx.globalAlpha = 1;
    h = hAt(t);
  } else {
    h = renderScene(t, frameNo);
    ctx.drawImage(glCanvas, 0, 0, W, H);
  }
  drawTags(t);
  drawOverlay(t, h);
}

window.INFO = {
  fps: FPS, duration: TEND, frames: Math.round(TEND * FPS), atoms: atomsData.count,
  gpu: (() => { const gl = renderer.getContext(); const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; })(),
};
window.frame = (t, q = 0.96) => { drawFrame(t); return out.toDataURL('image/jpeg', q); };
window.READY = true;

if (params.has('play')) {
  const t00 = performance.now(), off = parseFloat(params.get('t') || '0');
  const loop = () => { drawFrame((off + (performance.now() - t00) / 1000) % TEND); requestAnimationFrame(loop); };
  loop();
} else if (params.has('t')) {
  drawFrame(parseFloat(params.get('t')));
}
