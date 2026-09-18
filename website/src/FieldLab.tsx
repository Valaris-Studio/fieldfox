import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { RoundedBox } from "@react-three/drei";
import {
  CanvasTexture,
  MathUtils,
  SRGBColorSpace,
  type Group,
  type OrthographicCamera,
} from "three";
import "./scene.css";

type FieldLabProps = { stage: number; reducedMotion: boolean };
type Point = [number, number, number];
const paint = {
  orange: "#ed703b",
  ivory: "#f4f1e8",
  white: "#fffdf6",
  ink: "#22251f",
  blue: "#376cf0",
  pale: "#cad8f5",
  gray: "#b4b7aa",
};

function Block({
  size,
  position = [0, 0, 0],
  color = paint.white,
  radius = 0.04,
  roughness = 0.5,
}: {
  size: Point;
  position?: Point;
  color?: string;
  radius?: number;
  roughness?: number;
}) {
  return (
    <RoundedBox
      args={size}
      radius={Math.min(radius, Math.min(...size) * 0.45)}
      smoothness={3}
      position={position}
      castShadow
      receiveShadow
    >
      <meshStandardMaterial color={color} roughness={roughness} />
    </RoundedBox>
  );
}

function usePlateTexture(kind: "form" | "message" | "photo" | "label") {
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = kind === "label" ? 768 : 640;
    canvas.height = kind === "label" ? 160 : 800;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = paint.white;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const text = (
      value: string,
      x: number,
      y: number,
      size: number,
      color = paint.ink,
      weight = "500",
    ) => {
      ctx.fillStyle = color;
      ctx.font = `${weight} ${size}px ${kind === "label" ? "monospace" : "Arial, sans-serif"}`;
      ctx.fillText(value, x, y);
    };
    if (kind === "label") {
      text("FIELDFOX", 34, 103, 75, paint.ink, "700");
      ctx.fillStyle = paint.blue;
      ctx.fillRect(635, 49, 64, 64);
    } else if (kind === "form") {
      text("YOUR EXISTING FORM", 45, 63, 22, paint.ink, "700");
      text("Ready for your review.", 45, 116, 30);
      const rows = [
        ["NAME", "Alex Rivera"],
        ["PROJECT", "The garden studio"],
        ["LOCATION", "Not provided"],
      ];
      rows.forEach(([label, value], i) => {
        const y = 190 + i * 162;
        text(label, 45, y, 19, "#5b6058", "700");
        ctx.fillStyle = i === 2 ? "#efeee7" : "#e6edfc";
        ctx.fillRect(45, y + 23, 548, 92);
        text(value, 65, y + 79, 30, i === 2 ? "#72786d" : "#264d9e");
      });
      text("PROPOSED VALUES · NOT SUBMITTED", 45, 743, 19, "#5b6058", "700");
    } else if (kind === "message") {
      ctx.fillStyle = paint.blue;
      ctx.beginPath();
      ctx.arc(77, 84, 34, 0, Math.PI * 2);
      ctx.fill();
      text("A", 63, 98, 38, paint.white, "700");
      text("A little context", 131, 97, 34, paint.ink, "700");
      const lines = [
        "Hi! I’m Alex Rivera.",
        "Can you help with",
        "the garden studio?",
        "Here’s what I have",
        "so far…",
      ];
      lines.forEach((line, i) => text(line, 52, 207 + i * 63, 34));
      ctx.fillStyle = "#e8e9df";
      ctx.fillRect(52, 600, 430, 13);
      ctx.fillRect(52, 641, 335, 13);
    } else {
      text("A PHOTO. A PDF. A NOTE.", 42, 67, 23, paint.ink, "700");
      ctx.fillStyle = "#dbe5c8";
      ctx.fillRect(42, 114, 556, 474);
      ctx.fillStyle = "#859969";
      ctx.beginPath();
      ctx.moveTo(42, 588);
      ctx.lineTo(254, 269);
      ctx.lineTo(424, 588);
      ctx.fill();
      ctx.fillStyle = "#afbe92";
      ctx.beginPath();
      ctx.moveTo(243, 588);
      ctx.lineTo(449, 323);
      ctx.lineTo(598, 588);
      ctx.fill();
      ctx.fillStyle = paint.orange;
      ctx.beginPath();
      ctx.arc(475, 215, 45, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#d1d4c7";
      ctx.fillRect(42, 643, 492, 14);
      ctx.fillRect(42, 686, 372, 14);
    }
    const result = new CanvasTexture(canvas);
    result.colorSpace = SRGBColorSpace;
    result.anisotropy = 4;
    return result;
  }, [kind]);
  useEffect(() => () => texture.dispose(), [texture]);
  return texture;
}

function Sheet({
  kind,
  position,
  rotation = [0, 0, 0],
  scale = 1,
}: {
  kind: "form" | "message" | "photo";
  position: Point;
  rotation?: Point;
  scale?: number;
}) {
  const texture = usePlateTexture(kind);
  return (
    <group position={position} rotation={rotation} scale={scale}>
      <Block size={[1.22, 0.035, 1.525]} radius={0.015} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.019, 0]}>
        <planeGeometry args={[1.18, 1.475]} />
        <meshStandardMaterial map={texture} roughness={0.8} />
      </mesh>
    </group>
  );
}

function Fastener({ position }: { position: Point }) {
  return (
    <group position={position}>
      <mesh rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.042, 0.042, 0.023, 12]} />
        <meshStandardMaterial color={paint.gray} roughness={0.5} />
      </mesh>
      <Block
        size={[0.039, 0.009, 0.008]}
        position={[0, 0, 0.015]}
        color={paint.ink}
        radius={0.001}
      />
    </group>
  );
}

function Sorter({ stage, reducedMotion }: FieldLabProps) {
  const root = useRef<Group>(null);
  const lid = useRef<Group>(null);
  const paper = useRef<Group>(null);
  const form = useRef<Group>(null);
  const core = useRef<Group>(null);
  const invalidate = useThree((s) => s.invalidate);
  const nameplate = usePlateTexture("label");
  useEffect(() => invalidate(), [stage, reducedMotion, invalidate]);
  useFrame((_, elapsed) => {
    let moving = false;
    const approach = (value: number, target: number) => {
      const next = reducedMotion
        ? target
        : MathUtils.damp(value, target, 5.5, Math.min(elapsed, 0.06));
      if (Math.abs(next - target) < 0.001) return target;
      moving = true;
      return next;
    };
    if (root.current)
      root.current.rotation.y = approach(
        root.current.rotation.y,
        [0, -0.12, -0.25][stage] ?? 0,
      );
    if (lid.current)
      lid.current.position.y = approach(
        lid.current.position.y,
        stage === 1 ? 1.17 : 0,
      );
    if (core.current)
      core.current.position.y = approach(
        core.current.position.y,
        stage === 1 ? 0.32 : 0,
      );
    if (paper.current) {
      paper.current.position.x = approach(
        paper.current.position.x,
        stage === 0 ? -0.2 : 0.2,
      );
      paper.current.position.y = approach(
        paper.current.position.y,
        stage === 0 ? 0.25 : -0.08,
      );
    }
    if (form.current) {
      form.current.position.y = approach(
        form.current.position.y,
        stage === 2 ? 0.7 : 0,
      );
      form.current.rotation.x = approach(
        form.current.rotation.x,
        stage === 2 ? 0.37 : 0,
      );
    }
    if (moving) invalidate();
  });
  return (
    <group ref={root} position={[0, -0.25, 0]}>
      <Block
        size={[7.2, 0.26, 3.65]}
        position={[0, 0, 0]}
        color={paint.ivory}
        radius={0.12}
      />
      <Block
        size={[6.7, 0.12, 3.2]}
        position={[0, -0.17, 0]}
        color="#d9dcce"
        radius={0.05}
      />
      {[-2.88, 2.88].map((x) =>
        [-1.25, 1.25].map((z) => (
          <Block
            key={`${x}-${z}`}
            size={[0.31, 0.15, 0.31]}
            position={[x, -0.28, z]}
            color={paint.ink}
          />
        )),
      )}
      {/* Parallel rails make the source-to-form path a physical part of the object. */}
      {[-0.63, 0.63].map((z) => (
        <Block
          key={z}
          size={[6.52, 0.07, 0.08]}
          position={[0, 0.19, z]}
          color={paint.gray}
          radius={0.025}
        />
      ))}
      {[-2.75, -2.25, -1.75, 1.75, 2.25, 2.75].map((x) => (
        <mesh
          key={x}
          position={[x, 0.28, 0]}
          rotation={[Math.PI / 2, 0, 0]}
          castShadow
        >
          <cylinderGeometry args={[0.09, 0.09, 1.3, 18]} />
          <meshStandardMaterial color="#d8ddcf" roughness={0.4} />
        </mesh>
      ))}
      <group ref={paper}>
        <Sheet
          kind="photo"
          position={[-2.37, 0.75, -0.17]}
          rotation={[0.08, -0.22, -0.12]}
        />
        <Sheet
          kind="message"
          position={[-2.42, 1.03, 0.06]}
          rotation={[0.05, 0.14, -0.19]}
        />
      </group>
      <group position={[-0.2, 0, 0]}>
        <Block
          size={[2.12, 0.17, 2.24]}
          position={[0, 0.3, 0]}
          color={paint.ink}
          radius={0.06}
        />
        <Block
          size={[2.03, 0.54, 2.1]}
          position={[0, 0.64, 0]}
          color={paint.orange}
          radius={0.1}
        />
        <Block
          size={[1.57, 0.19, 0.07]}
          position={[0, 0.6, 1.065]}
          color={paint.ink}
          radius={0.06}
        />
        <Block
          size={[1.2, 0.035, 0.09]}
          position={[0, 0.6, 1.105]}
          color={paint.white}
          radius={0.01}
        />
        <group ref={core}>
          <Block
            size={[1.64, 0.12, 1.68]}
            position={[0, 0.96, 0]}
            color={paint.blue}
            radius={0.045}
          />
          <Block
            size={[0.68, 0.15, 0.7]}
            position={[0, 1.07, 0]}
            color={paint.ink}
          />
          <Block
            size={[0.47, 0.025, 0.48]}
            position={[0, 1.157, 0]}
            color={paint.pale}
            radius={0.02}
          />
          {[-1, 1].map((side) =>
            [0, 1, 2, 3, 4].map((i) => (
              <Block
                key={`${side}-${i}`}
                size={[0.09, 0.035, 0.04]}
                position={[side * 0.41, 1.08, -0.25 + i * 0.125]}
                color={paint.ivory}
                radius={0.003}
              />
            )),
          )}
        </group>
        <group ref={lid}>
          <Block
            size={[2.04, 0.91, 2.1]}
            position={[0, 1.31, 0]}
            color={paint.orange}
            radius={0.17}
            roughness={0.36}
          />
          <Block
            size={[1.98, 0.1, 2.05]}
            position={[0, 1.82, 0]}
            color="#f78a51"
            radius={0.045}
          />
          <Block
            size={[1.1, 0.085, 0.34]}
            position={[0, 1.91, -0.05]}
            color={paint.ink}
            radius={0.04}
          />
          {[-1, 1].map((side) => (
            <group
              key={side}
              position={[side * 0.77, 1.98, -0.24]}
              rotation={[0, 0, side * -0.18]}
            >
              <mesh castShadow>
                <coneGeometry args={[0.32, 0.74, 3]} />
                <meshStandardMaterial color={paint.orange} roughness={0.45} />
              </mesh>
              <mesh position={[0, 0.04, 0.12]} scale={[0.48, 0.57, 0.48]}>
                <coneGeometry args={[0.32, 0.74, 3]} />
                <meshStandardMaterial color={paint.ink} roughness={0.5} />
              </mesh>
            </group>
          ))}
          <Block
            size={[1.31, 0.28, 0.07]}
            position={[-0.13, 1.4, 1.046]}
            radius={0.04}
          />
          <mesh position={[-0.13, 1.4, 1.086]}>
            <planeGeometry args={[1.2, 0.25]} />
            <meshStandardMaterial map={nameplate} roughness={0.6} />
          </mesh>
          <mesh position={[0.77, 1.4, 1.08]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.067, 0.067, 0.06, 24]} />
            <meshStandardMaterial
              color={stage === 1 ? paint.blue : paint.ink}
              roughness={0.3}
            />
          </mesh>
          {[-0.87, 0.87].map((x) => (
            <Fastener key={x} position={[x, 1.03, 1.034]} />
          ))}
          {[0, 1, 2, 3].map((i) => (
            <Block
              key={i}
              size={[0.035, 0.055, 0.78]}
              position={[1.023, 1.2 + i * 0.115, 0]}
              color="#ae472b"
              radius={0.015}
            />
          ))}
        </group>
      </group>
      <group ref={form} position={[0, 0, 0]}>
        <group position={[2.24, 0.44, 0.15]} rotation={[0, -0.08, 0]}>
          <Block size={[1.67, 0.12, 2.05]} color={paint.blue} radius={0.06} />
          <Sheet kind="form" position={[0, 0.084, 0]} scale={1.19} />
          <Block
            size={[0.42, 0.07, 0.16]}
            position={[0, 0.143, -0.97]}
            color={paint.ink}
            radius={0.02}
          />
        </group>
      </group>
      {/* Instrument details are illustrative, never a claim of security certification. */}
      <Block
        size={[0.5, 0.012, 0.07]}
        position={[-2.72, 0.14, 1.43]}
        color={paint.blue}
        radius={0.003}
      />
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <Block
          key={i}
          size={[0.015, 0.012, i % 2 === 0 ? 0.15 : 0.09]}
          position={[1.83 + i * 0.13, 0.14, 1.4]}
          color={paint.gray}
          radius={0.001}
        />
      ))}
    </group>
  );
}

function CameraFit() {
  const { camera, size, invalidate } = useThree();
  useEffect(() => {
    const orthographic = camera as OrthographicCamera;
    orthographic.zoom = Math.min(size.width / 8.6, size.height / 5.9);
    orthographic.lookAt(0, 0.9, 0);
    orthographic.updateProjectionMatrix();
    invalidate();
  }, [camera, size, invalidate]);
  return null;
}

function Fallback({ loading = false }: { loading?: boolean }) {
  return (
    <div className="field-lab-fallback">
      <img
        src="/assets/sorting-machine.webp"
        width="1200"
        height="800"
        alt="An orange fox-shaped sorting machine turns source documents into proposed form values."
      />
      <span>
        {loading
          ? "Opening the little workshop…"
          : "The little workshop, in still life."}
      </span>
    </div>
  );
}

class SceneBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <Fallback /> : this.props.children;
  }
}

export default function FieldLab(props: FieldLabProps) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("webgl") === "off") {
      setAvailable(false);
      return;
    }
    const probe = document.createElement("canvas");
    try {
      const context = probe.getContext("webgl2", {
        failIfMajorPerformanceCaveat: true,
      });
      setAvailable(Boolean(context));
      context?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      setAvailable(false);
    }
  }, []);
  useEffect(() => {
    const lost = (event: Event) => {
      if (event.target !== canvas.current) return;
      event.preventDefault();
      setAvailable(false);
    };
    document.addEventListener("webglcontextlost", lost, true);
    return () => document.removeEventListener("webglcontextlost", lost, true);
  }, []);
  return (
    <div className="field-lab" data-stage={props.stage}>
      {available !== true ? (
        <Fallback loading={available === null} />
      ) : (
        <SceneBoundary>
          <Canvas
            orthographic
            camera={{ position: [6, 6, 9], near: 0.1, far: 60 }}
            shadows="percentage"
            frameloop="demand"
            dpr={[1, 1.6]}
            gl={{ antialias: true, alpha: true, powerPreference: "low-power" }}
            onCreated={({ gl }) => {
              canvas.current = gl.domElement;
              gl.setClearAlpha(0);
            }}
            aria-label="Illustrative FieldFox workshop: source documents, a processing machine, and a form for human review. The adjacent steps change its arrangement."
            fallback={
              <div aria-hidden="true">
                <Fallback />
              </div>
            }
          >
            <CameraFit />
            <ambientLight intensity={0.55} />
            <hemisphereLight args={["#fffdf5", "#b4b7aa", 1.15]} />
            <directionalLight
              position={[-3, 8, 5]}
              intensity={2.5}
              castShadow
              shadow-mapSize={[1024, 1024]}
              shadow-camera-left={-6}
              shadow-camera-right={6}
              shadow-camera-top={6}
              shadow-camera-bottom={-5}
              shadow-camera-near={0.5}
              shadow-camera-far={24}
              shadow-normalBias={0.028}
            />
            <directionalLight
              position={[5, 4, -5]}
              intensity={1.05}
              color="#dae3ff"
            />
            <Sorter {...props} />
            <mesh
              rotation={[-Math.PI / 2, 0, 0]}
              position={[0, -0.62, 0]}
              receiveShadow
            >
              <planeGeometry args={[40, 40]} />
              <shadowMaterial transparent opacity={0.12} />
            </mesh>
          </Canvas>
        </SceneBoundary>
      )}
    </div>
  );
}
