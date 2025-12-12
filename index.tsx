import React, { useState, useRef, useMemo, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, useFrame, extend, ReactThreeFiber } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, Environment, Float } from '@react-three/drei';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import * as THREE from 'three';

// --- CONFIGURATION ---
const TREE_HEIGHT = 12;
const TREE_RADIUS = 4.5;
const PARTICLE_COUNT = 18000;
const BOX_COUNT = 1200; // Red/White/Gold boxes
const BLUE_SPHERE_COUNT = 250; // New blue spheres for lower part

// Colors
const C_EMERALD = new THREE.Color("#004b2e");
const C_DEEP_GREEN = new THREE.Color("#001a0f");
const C_RED = new THREE.Color("#D41717"); // Holiday Red
const C_WHITE = new THREE.Color("#F5F5F5"); // Soft White
const C_GOLD = new THREE.Color("#FFD700"); // Luxury Gold
const C_BLUE = new THREE.Color("#1E3F66"); // Royal Blue
const C_ICE_BLUE = new THREE.Color("#A5D8FF"); // Lighter Ice Blue for variation

// --- UTILS ---

// Helper to get a random point inside a sphere
const randomInSphere = (radius: number) => {
  const u = Math.random();
  const v = Math.random();
  const theta = 2 * Math.PI * u;
  const phi = Math.acos(2 * v - 1);
  const r = Math.cbrt(Math.random()) * radius;
  const sinPhi = Math.sin(phi);
  return new THREE.Vector3(
    r * sinPhi * Math.cos(theta),
    r * sinPhi * Math.sin(theta),
    r * Math.cos(phi)
  );
};

// Helper to get a point on a cone surface (Christmas Tree shape)
// yMinRatio and yMaxRatio (0 to 1) allow constraining to parts of the tree
const randomOnTree = (height: number, radiusBase: number, yMinRatio = 0, yMaxRatio = 1) => {
  // y ranges from 0 (bottom) to height (top)
  const minH = height * yMinRatio;
  const maxH = height * yMaxRatio;
  const range = maxH - minH;
  
  const y = Math.random() * range + minH; 
  const percentage = 1 - (y / height); // 1 at bottom, 0 at top
  const r = radiusBase * Math.pow(percentage, 1.2); 
  const theta = Math.random() * Math.PI * 2;
  
  const layerNoise = Math.sin(y * 3.0) * 0.15; 
  
  return new THREE.Vector3(
    (r + layerNoise) * Math.cos(theta),
    y - height / 2, // Center vertically based on full height
    (r + layerNoise) * Math.sin(theta)
  );
};

// --- SHADERS ---

const foliageVertexShader = `
  uniform float uTime;
  uniform float uProgress; // 0 = Scattered, 1 = Tree
  uniform float uPixelRatio;

  attribute vec3 aScatterPos;
  attribute vec3 aTreePos;
  attribute float aRandom;
  attribute float aSize;
  attribute float aColorType; // 0=Green, 1=Red, 2=Silver, 3=Gold

  varying vec3 vColor;
  varying float vAlpha;

  // Easing function
  float easeOutCubic(float x) {
    return 1.0 - pow(1.0 - x, 3.0);
  }

  void main() {
    // Interpolate positions with some randomness based on particle ID
    float t = uProgress;
    
    // Add a delay based on height for the tree formation to look like it's spiraling up
    float delay = aTreePos.y * 0.05 + 0.5; 
    float localProgress = smoothstep(0.0, 1.0, (t * (1.0 + delay)) - (delay * (1.0 - t)));
    
    vec3 finalPos = mix(aScatterPos, aTreePos, easeOutCubic(localProgress));

    // Breathing effect
    float breath = sin(uTime * 2.0 + aRandom * 10.0) * 0.05; // Reduced breath for stability
    if (uProgress > 0.8) {
       finalPos += normalize(finalPos) * breath;
    }

    vec4 mvPosition = modelViewMatrix * vec4(finalPos, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    // Size attenuation - Reduced multiplier (14.0) for smaller particles
    gl_PointSize = (aSize * uPixelRatio) * (14.0 / -mvPosition.z);

    // --- COLOR PALETTE ---
    vec3 cDeep = vec3(0.0, 0.15, 0.05);  // Base Deep Green
    vec3 cEmerald = vec3(0.0, 0.55, 0.25); // Emerald Green
    vec3 cRed = vec3(0.95, 0.05, 0.2);     // Vibrant Christmas Red (Brighter)
    vec3 cSilver = vec3(0.95, 0.98, 1.0);  // Bright Silver
    vec3 cGold = vec3(1.0, 0.8, 0.2);      // Gold
    
    vec3 baseColor = cDeep;

    if (aColorType < 0.5) {
        // Green Gradient (50% of particles)
        float heightFactor = (aTreePos.y + 6.0) / 12.0; 
        baseColor = mix(cDeep, cEmerald, heightFactor + breath * 2.0);
    } else if (aColorType < 1.5) {
        // Red
        baseColor = cRed;
    } else if (aColorType < 2.5) {
        // Silver
        baseColor = cSilver;
    } else {
        // Gold
        baseColor = cGold;
    }
    
    // Glitter/Sparkle effect
    // Lowered speed from 3.0 to 1.0 for slower, more elegant twinkling
    float threshold = (aColorType > 1.5) ? 0.90 : 0.98; 
    float glitter = step(threshold, sin(uTime * 1.0 + aRandom * 100.0)); 
    
    // Mix glitter: flashes white/gold
    vColor = mix(baseColor, vec3(1.0, 0.9, 0.8), glitter * 0.8 * uProgress);
    
    vAlpha = 1.0;
  }
`;

const foliageFragmentShader = `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    // Soft particle circle
    vec2 coord = gl_PointCoord - vec2(0.5);
    float dist = length(coord);
    
    if (dist > 0.5) discard;

    // Gradient glow from center
    float strength = 1.0 - (dist * 2.0);
    strength = pow(strength, 1.5);

    gl_FragColor = vec4(vColor, vAlpha * strength);
  }
`;

// --- COMPONENTS ---

const FoliageSystem = ({ isTreeForm }: { isTreeForm: boolean }) => {
  const meshRef = useRef<THREE.Points>(null);
  const progress = useRef(0);

  // Generate data once
  const { positions, scatterPos, treePos, randoms, sizes, colorTypes } = useMemo(() => {
    const p = new Float32Array(PARTICLE_COUNT * 3);
    const sPos = new Float32Array(PARTICLE_COUNT * 3);
    const tPos = new Float32Array(PARTICLE_COUNT * 3);
    const r = new Float32Array(PARTICLE_COUNT);
    const s = new Float32Array(PARTICLE_COUNT);
    const cType = new Float32Array(PARTICLE_COUNT);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      // Tree destination
      const treeP = randomOnTree(TREE_HEIGHT, TREE_RADIUS);
      tPos[i * 3] = treeP.x;
      tPos[i * 3 + 1] = treeP.y;
      tPos[i * 3 + 2] = treeP.z;

      // Scatter destination (large sphere)
      const scatterP = randomInSphere(15);
      sPos[i * 3] = scatterP.x;
      sPos[i * 3 + 1] = scatterP.y;
      sPos[i * 3 + 2] = scatterP.z;

      // Initial buffer position
      p[i * 3] = scatterP.x;
      p[i * 3 + 1] = scatterP.y;
      p[i * 3 + 2] = scatterP.z;

      r[i] = Math.random();
      s[i] = Math.random() * 0.5 + 0.5; // Size variation
      
      // Color Distribution
      const rand = Math.random();
      if (rand > 0.95) cType[i] = 3.0;      // Gold (5%)
      else if (rand > 0.80) cType[i] = 2.0; // Silver (15%)
      else if (rand > 0.50) cType[i] = 1.0; // Red (30%)
      else cType[i] = 0.0;                  // Green (50%)
    }

    return { positions: p, scatterPos: sPos, treePos: tPos, randoms: r, sizes: s, colorTypes: cType };
  }, []);

  const uniforms = useMemo(() => ({
    uTime: { value: 0 },
    uProgress: { value: 0 },
    uPixelRatio: { value: typeof window !== 'undefined' ? window.devicePixelRatio : 1 }
  }), []);

  useFrame((state, delta) => {
    if (meshRef.current) {
      // Animate progress
      const target = isTreeForm ? 1 : 0;
      // Smooth lerp
      progress.current = THREE.MathUtils.lerp(progress.current, target, delta * 1.5);
      
      meshRef.current.material.uniforms.uTime.value = state.clock.elapsedTime;
      meshRef.current.material.uniforms.uProgress.value = progress.current;
      meshRef.current.rotation.y = state.clock.elapsedTime * 0.05 * progress.current; // Spin slowly when tree
    }
  });

  return (
    <points ref={meshRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={PARTICLE_COUNT} array={positions} itemSize={3} />
        <bufferAttribute attach="attributes-aScatterPos" count={PARTICLE_COUNT} array={scatterPos} itemSize={3} />
        <bufferAttribute attach="attributes-aTreePos" count={PARTICLE_COUNT} array={treePos} itemSize={3} />
        <bufferAttribute attach="attributes-aRandom" count={PARTICLE_COUNT} array={randoms} itemSize={1} />
        <bufferAttribute attach="attributes-aSize" count={PARTICLE_COUNT} array={sizes} itemSize={1} />
        <bufferAttribute attach="attributes-aColorType" count={PARTICLE_COUNT} array={colorTypes} itemSize={1} />
      </bufferGeometry>
      <shaderMaterial
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        vertexShader={foliageVertexShader}
        fragmentShader={foliageFragmentShader}
        uniforms={uniforms}
      />
    </points>
  );
};

const OrnamentSystem = ({ isTreeForm }: { isTreeForm: boolean }) => {
  const boxesRef = useRef<THREE.InstancedMesh>(null);
  const blueSpheresRef = useRef<THREE.InstancedMesh>(null);
  
  // Data for Boxes (Red / White / Gold)
  const boxes = useMemo(() => {
    const items = [];
    for (let i = 0; i < BOX_COUNT; i++) {
      const treeP = randomOnTree(TREE_HEIGHT - 0.5, TREE_RADIUS - 0.8); 
      const scatterP = randomInSphere(12);
      const scale = Math.random() * 0.08 + 0.2;
      
      // Color Logic with Gold
      const r = Math.random();
      let color;
      if (r < 0.20) color = C_GOLD; // 20% Gold
      else if (r < 0.60) color = C_RED; // 40% Red
      else color = C_WHITE; // 40% White

      items.push({
        treePos: treeP,
        scatterPos: scatterP,
        currentPos: scatterP.clone(),
        scale,
        speed: Math.random() * 0.05 + 0.02, 
        phase: Math.random() * Math.PI * 2,
        color: color,
        rotationAxis: new THREE.Vector3(Math.random(), Math.random(), Math.random()).normalize()
      });
    }
    return items;
  }, []);

  // Data for Blue Spheres (Lower part only)
  const blueSpheres = useMemo(() => {
    const items = [];
    for (let i = 0; i < BLUE_SPHERE_COUNT; i++) {
      // Only generate in the bottom 40% (0.0 to 0.4) of the tree height
      const treeP = randomOnTree(TREE_HEIGHT, TREE_RADIUS - 0.5, 0.0, 0.4); 
      const scatterP = randomInSphere(12);
      const scale = Math.random() * 0.08 + 0.12; // Slightly smaller than boxes
      
      items.push({
        treePos: treeP,
        scatterPos: scatterP,
        currentPos: scatterP.clone(),
        scale,
        speed: Math.random() * 0.05 + 0.02, 
        phase: Math.random() * Math.PI * 2,
        color: Math.random() > 0.6 ? C_BLUE : C_ICE_BLUE,
        rotationAxis: new THREE.Vector3(Math.random(), Math.random(), Math.random()).normalize()
      });
    }
    return items;
  }, []);

  const dummy = new THREE.Object3D();

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    
    // Update Boxes
    boxes.forEach((o, i) => {
      const target = isTreeForm ? o.treePos : o.scatterPos;
      o.currentPos.lerp(target, o.speed);
      const floatY = isTreeForm ? 0 : Math.sin(t + o.phase) * 0.02;
      
      dummy.position.copy(o.currentPos);
      dummy.position.y += floatY;
      // Slower rotation for luxury feel
      dummy.rotateOnAxis(o.rotationAxis, 0.005); 
      dummy.scale.setScalar(o.scale);
      dummy.updateMatrix();

      if (boxesRef.current) {
          boxesRef.current.setMatrixAt(i, dummy.matrix);
          boxesRef.current.setColorAt(i, o.color);
      }
    });

    // Update Blue Spheres
    blueSpheres.forEach((o, i) => {
      const target = isTreeForm ? o.treePos : o.scatterPos;
      o.currentPos.lerp(target, o.speed);
      const floatY = isTreeForm ? 0 : Math.sin(t + o.phase) * 0.02;
      
      dummy.position.copy(o.currentPos);
      dummy.position.y += floatY;
      dummy.scale.setScalar(o.scale);
      dummy.updateMatrix();

      if (blueSpheresRef.current) {
          blueSpheresRef.current.setMatrixAt(i, dummy.matrix);
          blueSpheresRef.current.setColorAt(i, o.color);
      }
    });

    if (boxesRef.current) {
        boxesRef.current.instanceMatrix.needsUpdate = true;
        if(boxesRef.current.instanceColor) boxesRef.current.instanceColor.needsUpdate = true;
    }
    if (blueSpheresRef.current) {
        blueSpheresRef.current.instanceMatrix.needsUpdate = true;
        if(blueSpheresRef.current.instanceColor) blueSpheresRef.current.instanceColor.needsUpdate = true;
    }
  });

  return (
    <group>
      {/* Red, White, and Gold Gift Boxes */}
      <instancedMesh ref={boxesRef} args={[undefined, undefined, BOX_COUNT]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial 
            roughness={0.2} 
            metalness={0.7}
            envMapIntensity={1.0}
        />
      </instancedMesh>
      
      {/* Blue Spheres (Bottom Only) */}
      <instancedMesh ref={blueSpheresRef} args={[undefined, undefined, BLUE_SPHERE_COUNT]}>
        <sphereGeometry args={[1, 16, 16]} />
        <meshStandardMaterial 
            roughness={0.2} 
            metalness={0.8}
            emissive="#000044"
            emissiveIntensity={0.2}
            envMapIntensity={1.5}
        />
      </instancedMesh>
    </group>
  );
};

const StarTopper = ({ isTreeForm }: { isTreeForm: boolean }) => {
  const meshRef = useRef<THREE.Mesh>(null);

  // Generate a 5-pointed star shape
  const starGeometry = useMemo(() => {
    const shape = new THREE.Shape();
    const points = 5;
    const outerRadius = 1;
    const innerRadius = 0.45;
    
    for(let i = 0; i < points * 2; i++){
        const r = i % 2 === 0 ? outerRadius : innerRadius;
        const a = (i / (points * 2)) * Math.PI * 2;
        const x = Math.cos(a + Math.PI/2) * r; // Rotate to point up
        const y = Math.sin(a + Math.PI/2) * r;
        if(i === 0) shape.moveTo(x, y);
        else shape.lineTo(x, y);
    }
    shape.closePath();
    
    const extrudeSettings = {
        depth: 0.3,
        bevelEnabled: true,
        bevelThickness: 0.1,
        bevelSize: 0.05,
        bevelSegments: 2
    };
    
    return new THREE.ExtrudeGeometry(shape, extrudeSettings);
  }, []);
  
  useFrame((state, delta) => {
    if (!meshRef.current) return;
    
    // Position target: Top of tree or floating above
    const treeY = TREE_HEIGHT / 2 + 0.8; 
    const scatterY = TREE_HEIGHT + 2; 
    
    const targetPos = new THREE.Vector3(
        0, 
        isTreeForm ? treeY : scatterY + Math.sin(state.clock.elapsedTime) * 0.5, 
        0
    );
    
    meshRef.current.position.lerp(targetPos, delta * 2.0);
    
    // Continuous rotation
    meshRef.current.rotation.y += delta * 0.8;
    
    // Scale pulse
    const currentScale = meshRef.current.scale.x;
    const targetScale = isTreeForm ? 0.8 : 0.001; 
    
    const s = THREE.MathUtils.lerp(currentScale, targetScale, delta * 2.0);
    meshRef.current.scale.setScalar(s);
  });

  return (
    <mesh ref={meshRef} geometry={starGeometry}>
      <meshStandardMaterial 
        color="#ffffff" 
        emissive="#ffffff" 
        emissiveIntensity={1.5} 
        roughness={0.1}
        metalness={1.0}
      />
    </mesh>
  );
}

// --- SCENE & LIGHTING ---

const App = () => {
  const [isTreeForm, setIsTreeForm] = useState(false);

  return (
    <>
      <div className="ui-layer">
        <button 
          className="lux-btn"
          onClick={() => setIsTreeForm(!isTreeForm)}
        >
          {isTreeForm ? "Disperse Elements" : "Assemble Form"}
        </button>
      </div>

      <div className="title-overlay">
        <h1>ARIX SIGNATURE</h1>
        <p>Interactive Holiday Experience</p>
      </div>

      <Canvas
        dpr={[1, 2]}
        gl={{ 
            antialias: false,
            toneMapping: THREE.ReinhardToneMapping,
            toneMappingExposure: 1.0, // Reduced exposure from 1.5
            powerPreference: "high-performance"
        }}
      >
        <PerspectiveCamera makeDefault position={[0, 2, 18]} fov={45} />
        <OrbitControls 
            enablePan={false} 
            minPolarAngle={Math.PI / 4} 
            maxPolarAngle={Math.PI / 1.8}
            minDistance={10}
            maxDistance={30}
            autoRotate={isTreeForm}
            autoRotateSpeed={0.5}
            dampingFactor={0.05}
        />

        <color attach="background" args={['#000508']} />
        
        {/* Cinematic Lighting - Slightly dimmed */}
        <ambientLight intensity={0.1} color="#001a0f" />
        
        {/* Main warm spotlight from top-front */}
        <spotLight 
          position={[10, 20, 10]} 
          angle={0.3} 
          penumbra={1} 
          intensity={600} 
          color="#ffdfaa" 
          castShadow 
        />
        
        {/* Rim light for gold reflection */}
        <pointLight position={[-10, 5, -10]} intensity={300} color="#00ffaa" decay={2} />
        <pointLight position={[10, -5, -10]} intensity={200} color="#ffaa00" decay={2} />

        <group position={[0, -2, 0]}>
          <FoliageSystem isTreeForm={isTreeForm} />
          <OrnamentSystem isTreeForm={isTreeForm} />
          <StarTopper isTreeForm={isTreeForm} />
        </group>

        {/* Post Processing */}
        <EffectComposer disableNormalPass>
            <Bloom 
                luminanceThreshold={0.4} 
                mipmapBlur 
                intensity={1.0} 
                radius={0.6}
            />
            <Vignette eskil={false} offset={0.1} darkness={1.1} />
        </EffectComposer>

        {/* Environment for reflections */}
        <Environment preset="city" />
      </Canvas>
    </>
  );
};

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<App />);