import { Component, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Edges, Line, OrbitControls, RoundedBox } from '@react-three/drei'
import { MathUtils, WebGLRenderer, type Group } from 'three'
import { materialColors as color } from './palette'

type SceneProps = { step: number; exploded: boolean; paused: boolean; technical: boolean; turn: number }

function Block({ position = [0, 0, 0], size, color: paint, radius = 0.06 }: {
  position?: [number, number, number]; size: [number, number, number]; color: string; radius?: number
}) {
  return <RoundedBox args={size} radius={radius} smoothness={3} position={position} castShadow receiveShadow>
    <meshStandardMaterial color={paint} roughness={0.36} />
  </RoundedBox>
}

function Paper({ position, rotation = [0, 0, 0], mark = color.signal }: {
  position: [number, number, number]; rotation?: [number, number, number]; mark?: string
}) {
  return <group position={position} rotation={rotation}>
    <Block size={[0.95, 0.025, 1.23]} color={color.source} radius={0.014} />
    <Block size={[0.2, 0.018, 0.2]} position={[-0.27, 0.026, -0.34]} color={mark} radius={0.012} />
    {[0, 1, 2].map(i => <Block key={i} size={[i === 2 ? 0.4 : 0.64, 0.012, 0.035]} position={[i === 2 ? -0.12 : 0, 0.025, 0.04 + i * 0.16]} color={color.hardware} radius={0.005} />)}
  </group>
}

function Tray({ x, z, mark }: { x: number; z: number; mark: string }) {
  return <group position={[x, 0.11, z]}>
    <Block size={[1.12, 0.12, 1.47]} color={color.source} />
    <Block size={[1.14, 0.24, 0.09]} position={[0, 0.08, 0.7]} color={color.hardware} radius={0.03} />
    <Block size={[0.09, 0.24, 1.47]} position={[-0.52, 0.08, 0]} color={color.hardware} radius={0.03} />
    <Block size={[0.09, 0.24, 1.47]} position={[0.52, 0.08, 0]} color={color.hardware} radius={0.03} />
    <Block size={[0.3, 0.026, 0.12]} position={[0, 0.21, 0.7]} color={mark} radius={0.01} />
    <Paper position={[0, 0.15, -0.08]} mark={mark} />
  </group>
}

function Mechanism({ step, exploded, paused, technical, turn }: SceneProps) {
  const assembly = useRef<Group>(null)
  const cap = useRef<Group>(null)
  const source = useRef<Group>(null)
  const outputs = useRef<Group>(null)
  const invalidate = useThree(s => s.invalidate)
  useEffect(() => invalidate(), [step, exploded, paused, technical, turn, invalidate])
  useFrame((_, frameDelta) => {
    const delta = Math.min(frameDelta, 0.05)
    const spread = exploded ? 1 : step === 2 ? 0.48 : 0
    let moving = false
    const shift = (current: number, target: number) => {
      const next = paused ? target : MathUtils.damp(current, target, 5, delta)
      if (Math.abs(next - target) > 0.001) moving = true
      return Math.abs(next - target) < 0.001 ? target : next
    }
    if (assembly.current) assembly.current.rotation.y = shift(assembly.current.rotation.y, turn * Math.PI / 6 + [0, -0.15, -0.32, 0.08, 0.22, -0.15][step])
    if (cap.current) cap.current.position.y = shift(cap.current.position.y, spread * 1.2)
    if (source.current) {
      source.current.position.y = shift(source.current.position.y, spread * 0.2 + (step === 0 ? 0.3 : 0))
      source.current.position.z = shift(source.current.position.z, step > 0 ? 0.3 : 0)
    }
    if (outputs.current) outputs.current.position.z = shift(outputs.current.position.z, spread * 0.8 + (step === 4 ? 0.5 : step > 2 ? 0.26 : 0))
    if (moving) invalidate()
  })
  return <group ref={assembly} position={[0, -0.47, 0]}>
    <Block size={[4.1, 0.24, 4.5]} position={[0, -0.15, 0]} color={color.hardware} radius={0.12} />
    <Block size={[3.95, 0.10, 4.35]} position={[0, 0, 0]} color={color.source} radius={0.07} />
    <group position={[0, 0, -0.43]}>
      <Block size={[2.63, 1.8, 1.9]} position={[0, 1, 0]} color={color.machine} radius={0.23} />
      <Block size={[2.7, 0.21, 2]} position={[0, 0.24, 0]} color={color.ink} radius={0.09} />
      <Block size={[2.16, 0.54, 0.07]} position={[0, 0.67, 0.96]} color={color.ink} radius={0.1} />
      <Block size={[1.72, 0.065, 0.18]} position={[0, 0.69, 1.025]} color={color.hardware} radius={0.025} />
      <Block size={[1.25, 0.35, 0.055]} position={[-0.31, 1.37, 0.962]} color={color.source} radius={0.06} />
      {[0, 1, 2].map(i => <Block key={i} size={[0.07, 0.11 + i * 0.035, 0.02]} position={[-0.64 + i * 0.19, 1.37, 1]} color={color.ink} radius={0.01} />)}
      <mesh position={[0.87, 1.36, 0.995]} rotation={[Math.PI / 2, 0, 0]} castShadow><cylinderGeometry args={[0.125, 0.125, 0.10, 32]} /><meshStandardMaterial color={step > 1 ? color.signal : color.hardware} roughness={0.24} /></mesh>
      <group ref={cap}>
        <Block size={[2.45, 0.19, 1.83]} position={[0, 1.98, 0]} color={color.machine} radius={0.085} />
        <Block size={[1.55, 0.08, 0.23]} position={[0, 2.10, 0]} color={color.ink} radius={0.035} />
        {[-1, 1].map(side => <group key={side} position={[side * 0.96, 2.21, -0.12]} rotation={[0, 0, side * -0.15]}><mesh castShadow><coneGeometry args={[0.32, 0.67, 3]} /><meshStandardMaterial color={color.machine} roughness={0.32} /></mesh></group>)}
      </group>
      {(technical || step === 1) && <mesh position={[0, 1, 0]}><boxGeometry args={[2.82, 1.95, 2.13]} /><meshBasicMaterial visible={false} /><Edges color={color.signal} /></mesh>}
    </group>
    <group ref={source}>
      <Paper position={[0, 2.3, -0.7]} rotation={[0.2, -0.12, -0.17]} />
      <Paper position={[-0.13, 2.64, -0.82]} rotation={[0.32, 0.12, 0.12]} mark={color.machine} />
      <Paper position={[0.13, 2.96, -1.03]} rotation={[0.36, -0.28, -0.06]} />
    </group>
    <group ref={outputs}>
      <Tray x={-0.66} z={1.3} mark={color.signal} />
      <Tray x={0.66} z={1.3} mark={color.machine} />
    </group>
    {technical && <group>
      <Line points={[[-2.3, 0, 2.8], [2.3, 0, 2.8]]} color={color.signal} lineWidth={0.7} dashed dashSize={0.08} gapSize={0.07} />
      <Line points={[[-2.3, 0, 2.62], [-2.3, 0, 2.98]]} color={color.signal} lineWidth={1} />
      <Line points={[[2.3, 0, 2.62], [2.3, 0, 2.98]]} color={color.signal} lineWidth={1} />
      <Line points={[[2.4, 0, -2], [2.4, 3.5, -2], [-2.4, 3.5, -2]]} color={color.signal} lineWidth={0.7} dashed dashSize={0.1} gapSize={0.06} />
    </group>}
  </group>
}

function Fallback() {
  return <div className="scene-fallback"><span className="fallback-machine" aria-hidden="true">↳</span><p>Source → plan → supported fields → your review</p><small>3D is unavailable. Every explanation and diagram is still here.</small></div>
}

class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <Fallback /> : this.props.children }
}

export default function SortingLab(props: SceneProps) {
  const [available, setAvailable] = useState<boolean | null>(null)
  const canvasElement = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    // Catch capability failures before Fiber's asynchronous renderer initialization.
    const probe = document.createElement('canvas')
    let renderer: WebGLRenderer | null = null
    try {
      const context = probe.getContext('webgl2', { failIfMajorPerformanceCaveat: true })
      if (!context) { setAvailable(false); return }
      renderer = new WebGLRenderer({ canvas: probe, context })
      setAvailable(true)
    } catch { setAvailable(false) }
    finally { renderer?.dispose(); renderer?.forceContextLoss() }
    return () => { canvasElement.current = null }
  }, [])
  useEffect(() => {
    if (!available) return
    const onContextLost = (event: Event) => {
      if (event.target !== canvasElement.current) return
      event.preventDefault()
      setAvailable(false)
    }
    document.addEventListener('webglcontextlost', onContextLost, true)
    return () => document.removeEventListener('webglcontextlost', onContextLost, true)
  }, [available])
  if (available === null) return <div className="scene-loading mono">Preparing the little laboratory…</div>
  if (!available) return <Fallback />
  return <SceneBoundary><Canvas
    shadows="percentage" frameloop="demand" dpr={[1, 1.7]}
    camera={{ position: [6, 5.5, 8], fov: 36 }}
    aria-label="Illustrative 3D Fieldfox sorting machine. Use the adjacent controls to rotate or separate its parts."
    gl={{ antialias: true, alpha: true }}
    onCreated={({ gl }) => { canvasElement.current = gl.domElement; gl.setClearColor(color.ground, 0) }}
  >
    <ambientLight intensity={1.3} />
    <hemisphereLight args={[color.source, color.hardware, 2]} />
    <directionalLight position={[-3, 7, 5]} intensity={3.7} castShadow shadow-mapSize={[1024, 1024]} shadow-camera-left={-5} shadow-camera-right={5} shadow-camera-top={6} shadow-camera-bottom={-5} shadow-normalBias={0.025} />
    <directionalLight position={[5, 2, -4]} intensity={2} color={color.source} />
    <Suspense fallback={null}><Mechanism {...props} /></Suspense>
    <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.77, 0]}><planeGeometry args={[200, 200]} /><shadowMaterial transparent opacity={0.13} /></mesh>
    <OrbitControls makeDefault enablePan={false} enableZoom={false} enableDamping={!props.paused} minPolarAngle={0.3} maxPolarAngle={1.4} target={[0, 0.85, 0]} />
  </Canvas></SceneBoundary>
}
