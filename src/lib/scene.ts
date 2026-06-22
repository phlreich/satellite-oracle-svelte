import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { twoline2satrec, gstime, geodeticToEcf, ecfToEci } from 'satellite.js';
import Stats from 'three/examples/jsm/libs/stats.module.js';
import type { Writable } from 'svelte/store';
import earthTextureUrl from '$lib/assets/earth.webp';

type SceneDataRow = [string, string, string, number, string];
type QueryResultRow = { NORAD_CAT_ID: number };
type SharedSceneData = [QueryResultRow[], 'replace' | 'add' | 'remove'] | [];
type OrbitOverlayMode = 'replace' | 'add' | 'remove';
type SceneSatellite = {
	tleLine1: string;
	tleLine2: string;
	norad_cat_id: number;
	satrec?: unknown;
};
type OrbitWorkerPoint = { x: number; y: number; z: number };
type OrbitWorkerResponse = {
	type: 'orbit-points';
	kind: 'focus' | 'overlay';
	requestId: number;
	generation?: number;
	satelliteIndex: number;
	points: OrbitWorkerPoint[];
};
type WorkerLoopStatsMessage = {
	type: 'loop-stats';
	workerId: number;
	assignedCount: number;
	updatedCount: number;
	loopMs: number;
	finishedAtMs: number;
};
type WorkerLoopSnapshot = {
	assignedCount: number;
	updatedCount: number;
	loopMs: number;
	finishedAtMs: number;
};
type InterpolationHealthSnapshot = {
	interpolating: number;
	holdingPrevious: number;
	currentSample: number;
	extrapolating: number;
	clamped: number;
	missingCurrent: number;
};
type SelectedSatelliteState = {
	name: string;
	details: object | string;
	noradCatId?: number;
	latitude?: number;
	longitude?: number;
	index?: number;
	satrec?: unknown;
} | null;
type TextureReadyResult = 'loaded' | 'failed' | 'timeout';
type SceneController = {
	textureReady: Promise<TextureReadyResult>;
	loadSatellites: (satellites: SceneDataRow[]) => Promise<void>;
	cleanup: () => void;
	focusPreviousVisibleSatellite: () => void;
	focusNextVisibleSatellite: () => void;
	getVisibleCount: () => number;
	focusEarth: () => boolean;
	focusVisibleNoradId: (noradCatId: number) => boolean;
	applyOrbitOverlay: (noradCatIds: number[], mode: OrbitOverlayMode) => void;
};

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
	40,
	window.innerWidth / window.innerHeight,
	0.1,
	1000000
);

const scale = 2 * 6356.7523;
camera.position.z = scale;
camera.position.y = scale;
camera.position.x = scale;

let renderer: THREE.WebGLRenderer;
let animationFrameId: number;

const resolution = 100;
const earthRadius = 6356.7523;
const lineSurfaceOffset = 2; // avoid z-fighting where line meets the surface
const oneSiderealDayInMilliseconds = 86164.0916 * 1000;
const referenceTime = new Date().setUTCHours(0, 0, 0, 0);
const gmstAtReferenceTimeRad = gstime(new Date(referenceTime));
const textureAlignmentOffsetRad = -Math.PI / 2;
const austinLatitudeRad = THREE.MathUtils.degToRad(30.2672);
const austinLongitudeRad = THREE.MathUtils.degToRad(-97.7431);

const getEarthRotationAtTimeRad = (timeMs: number) => {
	const timeElapsed = timeMs - referenceTime;
	return (
		((timeElapsed % oneSiderealDayInMilliseconds) / oneSiderealDayInMilliseconds) * Math.PI * 2
	);
};

const getAustinTargetAtTime = (time: Date) => {
	const gmst = gstime(time);
	const austinEci = ecfToEci(
		geodeticToEcf({
			latitude: austinLatitudeRad,
			longitude: austinLongitudeRad,
			height: 0
		}),
		gmst
	);
	// Scene axes are [ECI y, ECI z, ECI x].
	return new THREE.Vector3(austinEci.y, austinEci.z, austinEci.x)
		.normalize()
		.multiplyScalar(earthRadius);
};

const earthGeometry = new THREE.SphereGeometry(earthRadius, resolution, resolution);
const initialMaterial = new THREE.MeshBasicMaterial({ color: 0x005f9a });
const earthMesh = new THREE.Mesh(earthGeometry, initialMaterial);
scene.add(earthMesh);
const textureLoader = new THREE.TextureLoader();
const textureReadyTimeoutMs = 3000;
const textureReady: Promise<TextureReadyResult> = new Promise((resolve) => {
	let settled = false;
	const finish = (result: TextureReadyResult) => {
		if (settled) {
			return;
		}
		settled = true;
		window.clearTimeout(timeoutId);
		resolve(result);
	};
	const timeoutId = window.setTimeout(() => finish('timeout'), textureReadyTimeoutMs);
	textureLoader.load(
		earthTextureUrl,
		(texture) => {
			texture.colorSpace = THREE.SRGBColorSpace;
			earthMesh.material = new THREE.MeshBasicMaterial({ map: texture });
			earthMesh.material.needsUpdate = true;
			finish('loaded');
		},
		undefined,
		(error) => {
			console.error('Failed to load Earth texture:', error);
			finish('failed');
		}
	);
});

const vertexShader = `
attribute float size;
attribute vec3 customColor;
attribute float visibility;
varying vec3 vColor;

void main() {
    if (visibility < 0.5) {
        gl_Position = vec4(0.0, 0.0, 0.0, 0.0);
        return;
    } else {
        vColor = customColor;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * (20.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
    }
}`;

const fragmentShader = `
uniform vec3 color;
varying vec3 vColor;

void main() {
    vec2 cxy = 2.0 * gl_PointCoord - 1.0;
    float r = dot(cxy, cxy);
	gl_FragColor = vec4(color * vColor, 1.0);
    if (r > 1.0) {
        discard;  // discard pixels outside the total point radius
    }
}
`;

const satelliteMaterial = new THREE.ShaderMaterial({
	uniforms: {
		color: { value: new THREE.Color(0xffffff) }
	},
	vertexShader: vertexShader,
	fragmentShader: fragmentShader
});

const stats = new Stats();

const fitEarthInView = () => {
	if (!(camera instanceof THREE.PerspectiveCamera)) {
		return;
	}
	const aspect = window.innerWidth / window.innerHeight;
	const verticalFov = THREE.MathUtils.degToRad(camera.fov);
	const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * aspect);
	const limitingFov = Math.min(verticalFov, horizontalFov);
	const distanceForFit = (earthRadius / Math.sin(limitingFov / 2)) * 1.08;
	const currentDistance = camera.position.length();
	if (distanceForFit > currentDistance) {
		const direction = camera.position.clone().normalize();
		camera.position.copy(direction.multiplyScalar(distanceForFit));
	}
};

const resize = () => {
	renderer.setSize(window.innerWidth, window.innerHeight);
	if (camera instanceof THREE.PerspectiveCamera) {
		camera.aspect = window.innerWidth / window.innerHeight;
	}
	camera.updateProjectionMatrix();
	fitEarthInView();
};

const assertSceneRuntimeSupport = () => {
	const missingFeatures: string[] = [];
	if (typeof SharedArrayBuffer === 'undefined') {
		missingFeatures.push('SharedArrayBuffer');
	}
	if (!window.crossOriginIsolated) {
		missingFeatures.push('cross-origin isolation');
	}
	if (typeof Worker === 'undefined') {
		missingFeatures.push('Web Workers');
	}
	if (missingFeatures.length > 0) {
		throw new Error(`Missing required scene features: ${missingFeatures.join(', ')}.`);
	}
};

export const createScene = (
	el: HTMLCanvasElement,
	selectedSatellite: Writable<SelectedSatelliteState>,
	sharedData: Writable<SharedSceneData>
): SceneController => {
	assertSceneRuntimeSupport();

	const raycaster = new THREE.Raycaster();
	raycaster.params.Points = { threshold: 20 };
	const mouse = new THREE.Vector2();
	const showSceneDebug =
		import.meta.env.DEV || new URLSearchParams(window.location.search).has('debug');
	const showMotionDebugOverlay = showSceneDebug;

	let hoveredSatelliteIndex: number | undefined;
	renderer = new THREE.WebGLRenderer({ antialias: true, canvas: el });
	const controls = new OrbitControls(camera, renderer.domElement);
	controls.enableDamping = true;
	controls.dampingFactor = 0.1;
	let axesHelper: THREE.AxesHelper | undefined;
	if (showSceneDebug) {
		stats.dom.style.position = 'fixed';
		stats.dom.style.left = '8px';
		stats.dom.style.top = '8px';
		stats.dom.style.zIndex = '100001';
		if (!stats.dom.isConnected) {
			document.body.appendChild(stats.dom);
		}
		axesHelper = new THREE.AxesHelper(10000);
		scene.add(axesHelper);
	}

	// Optional: Adjust these for how fast the user can zoom/pan
	controls.zoomSpeed = 0.8;
	controls.panSpeed = 0.8;
	controls.rotateSpeed = 0.8;
	controls.maxDistance = 1000000;
	controls.minDistance = 7000;
	const initialViewTime = new Date();
	const austinTarget = getAustinTargetAtTime(initialViewTime);
	const initialCameraDistance = camera.position.length();
	const earthCenter = new THREE.Vector3(0, 0, 0);
	camera.position.copy(austinTarget.clone().normalize().multiplyScalar(initialCameraDistance));
	controls.target.copy(earthCenter);
	camera.lookAt(earthCenter);
	earthMesh.rotation.y =
		gmstAtReferenceTimeRad +
		getEarthRotationAtTimeRad(initialViewTime.getTime()) +
		textureAlignmentOffsetRad;
	controls.update();

	let satelliteFrameUpdate: (currentTime: number) => void = () => {};
	let cleanupSatellites = () => {};
	let disposed = false;
	let satellitesLoaded = false;
	let focusPreviousVisibleSatelliteImpl = () => {};
	let focusNextVisibleSatelliteImpl = () => {};
	let getVisibleCountImpl = () => 0;
	let focusEarthImpl = () => false;
	let focusVisibleNoradIdImpl: (noradCatId: number) => boolean = () => false;
	let applyOrbitOverlayImpl: (noradCatIds: number[], mode: OrbitOverlayMode) => void = () => {};

	const loadSatellites = async (satellites: SceneDataRow[]) => {
		if (disposed || satellitesLoaded) {
			return;
		}
		satellitesLoaded = true;

		// initialize satellite positions
		const N = satellites.length;
		const sharedBufferPreviousPositions = new SharedArrayBuffer(
			N * 3 * Float32Array.BYTES_PER_ELEMENT
		);
		const sharedBufferPreviousVelocities = new SharedArrayBuffer(
			N * 3 * Float32Array.BYTES_PER_ELEMENT
		);
		const sharedBufferPreviousUpdateTimes = new SharedArrayBuffer(
			N * Float64Array.BYTES_PER_ELEMENT
		);
		const sharedBufferCurrentPositions = new SharedArrayBuffer(
			N * 3 * Float32Array.BYTES_PER_ELEMENT
		);
		const sharedBufferCurrentVelocities = new SharedArrayBuffer(
			N * 3 * Float32Array.BYTES_PER_ELEMENT
		);
		const sharedBufferCurrentUpdateTimes = new SharedArrayBuffer(
			N * Float64Array.BYTES_PER_ELEMENT
		);
		const sharedBufferComputeVisibility = new SharedArrayBuffer(
			N * 1 * Uint8Array.BYTES_PER_ELEMENT
		);
		const satellitePreviousPositions = new Float32Array(sharedBufferPreviousPositions);
		const satellitePreviousVelocities = new Float32Array(sharedBufferPreviousVelocities);
		const satellitePreviousUpdateTimes = new Float64Array(sharedBufferPreviousUpdateTimes);
		const satelliteCurrentPositions = new Float32Array(sharedBufferCurrentPositions);
		const satelliteCurrentVelocities = new Float32Array(sharedBufferCurrentVelocities);
		const satelliteCurrentUpdateTimes = new Float64Array(sharedBufferCurrentUpdateTimes);
		const satelliteRenderPositions = new Float32Array(N * 3);
		let activeVisibleIndices: number[] = [];
		let activeComputeIndices: number[] = [];
		const computeVisibility = new Uint8Array(sharedBufferComputeVisibility);
		const renderReady = new Uint8Array(N);
		const renderVisible = new Uint8Array(N);

		const colors = new Float32Array(N * 3); // three components per color
		const sizes = new Float32Array(N); // one component per size
		for (let i = 0; i < N; i++) {
			colors[i * 3] = 1.0; // red
			colors[i * 3 + 1] = 1.0; // green
			colors[i * 3 + 2] = 1.0; // blue
			sizes[i] = 2000; // size
		}

		// Compute every loaded object by default, but draw only after a worker has produced a sample.
		computeVisibility.fill(1);

		const satelliteData: SceneSatellite[] = satellites.map((sat: SceneDataRow) => {
			const [, tleLine1, tleLine2, norad_cat_id] = sat;
			return { tleLine1, tleLine2, norad_cat_id };
		});
		const satelliteIndexByNoradId = new Map<number, number>();
		for (let i = 0; i < satelliteData.length; i++) {
			satelliteIndexByNoradId.set(satelliteData[i].norad_cat_id, i);
		}
		const getSatelliteSatrec = (index: number) => {
			const satellite = satelliteData[index];
			if (!satellite) {
				return undefined;
			}
			if (!satellite.satrec) {
				satellite.satrec = twoline2satrec(satellite.tleLine1, satellite.tleLine2);
			}
			return satellite.satrec;
		};
		const workerUpdateIntervalMs = 250;
		const motionSmoothingDelayMs = Math.max(120, Math.round(workerUpdateIntervalMs * 0.9));
		const maxExtrapolationSeconds = (workerUpdateIntervalMs * 2) / 1000;
		const workerCount = Math.max(
			1,
			Math.min(4, Math.floor((navigator.hardwareConcurrency ?? 4) / 2) || 1)
		);
		const satelliteWorkers = Array.from({ length: workerCount }, () => {
			// Keep worker construction inline so Vite emits the hashed worker asset.
			return new Worker(new URL('./satelliteWorker.js', import.meta.url), { type: 'module' });
		});
		const overlayUpdateIntervalMs = 180;
		const workerStatsFreshMs = 2200;
		let motionDebugOverlay: HTMLPreElement | undefined;
		let lastOverlayUpdateMs = 0;
		const workerLoopStats = new Map<number, WorkerLoopSnapshot>();
		let interpolationHealth: InterpolationHealthSnapshot = {
			interpolating: 0,
			holdingPrevious: 0,
			currentSample: 0,
			extrapolating: 0,
			clamped: 0,
			missingCurrent: 0
		};

		function createMotionDebugOverlay() {
			if (!showMotionDebugOverlay || motionDebugOverlay) {
				return;
			}
			const overlay = document.createElement('pre');
			overlay.style.position = 'fixed';
			overlay.style.top = '48px';
			overlay.style.right = '8px';
			overlay.style.zIndex = '100001';
			overlay.style.margin = '0';
			overlay.style.padding = '8px 10px';
			overlay.style.pointerEvents = 'none';
			overlay.style.whiteSpace = 'pre';
			overlay.style.fontFamily = "Consolas, 'Courier New', 'Liberation Mono', monospace";
			overlay.style.fontSize = '11px';
			overlay.style.lineHeight = '1.35';
			overlay.style.letterSpacing = '0.04em';
			overlay.style.color = '#9de3ff';
			overlay.style.background = 'rgba(0, 0, 0, 0.72)';
			overlay.style.border = '1px solid rgba(157, 227, 255, 0.5)';
			overlay.textContent = 'MOTION DEBUG: warming up...';
			document.body.appendChild(overlay);
			motionDebugOverlay = overlay;
		}

		function updateMotionDebugOverlay(nowMs: number) {
			if (!motionDebugOverlay || nowMs - lastOverlayUpdateMs < overlayUpdateIntervalMs) {
				return;
			}
			lastOverlayUpdateMs = nowMs;

			let readyCount = 0;
			let staleSumMs = 0;
			let staleMaxMs = 0;
			let staleOverTick = 0;
			let staleOverClamp = 0;
			for (let i = 0; i < activeComputeIndices.length; i++) {
				const updateTimeMs = satelliteCurrentUpdateTimes[activeComputeIndices[i]];
				if (updateTimeMs <= 0) {
					continue;
				}
				readyCount += 1;
				const staleMs = Math.max(0, nowMs - updateTimeMs);
				staleSumMs += staleMs;
				if (staleMs > staleMaxMs) {
					staleMaxMs = staleMs;
				}
				if (staleMs > workerUpdateIntervalMs) {
					staleOverTick += 1;
				}
				if (staleMs > workerUpdateIntervalMs * 2) {
					staleOverClamp += 1;
				}
			}

			const freshWorkerStats = [...workerLoopStats.values()].filter(
				(snapshot) => nowMs - snapshot.finishedAtMs <= workerStatsFreshMs
			);
			const workerAssigned = freshWorkerStats.reduce(
				(sum, snapshot) => sum + snapshot.assignedCount,
				0
			);
			const workerUpdated = freshWorkerStats.reduce(
				(sum, snapshot) => sum + snapshot.updatedCount,
				0
			);
			const totalLoopMs = freshWorkerStats.reduce((sum, snapshot) => sum + snapshot.loopMs, 0);
			const maxLoopMs = freshWorkerStats.reduce(
				(max, snapshot) => Math.max(max, snapshot.loopMs),
				0
			);
			const avgLoopMs = freshWorkerStats.length > 0 ? totalLoopMs / freshWorkerStats.length : 0;
			const slowLoopCount = freshWorkerStats.filter(
				(snapshot) => snapshot.loopMs > workerUpdateIntervalMs
			).length;

			const avgStaleMs = readyCount > 0 ? staleSumMs / readyCount : 0;
			const visibleCount = activeVisibleIndices.length;
			const computeCount = activeComputeIndices.length;
			const interpolationPct =
				visibleCount > 0 ? (interpolationHealth.interpolating / visibleCount) * 100 : 0;
			const extrapolationPct =
				visibleCount > 0 ? (interpolationHealth.extrapolating / visibleCount) * 100 : 0;
			motionDebugOverlay.textContent = [
				'MOTION DEBUG',
				`visible ${activeVisibleIndices.length}  compute ${computeCount}  ready ${readyCount}`,
				`render delay ${motionSmoothingDelayMs}ms`,
				`stale avg ${avgStaleMs.toFixed(0)}ms  max ${staleMaxMs.toFixed(0)}ms`,
				`stale>${workerUpdateIntervalMs}ms ${staleOverTick}  stale>${workerUpdateIntervalMs * 2}ms ${staleOverClamp}`,
				`interp ${interpolationHealth.interpolating} (${interpolationPct.toFixed(0)}%)  extrap ${interpolationHealth.extrapolating} (${extrapolationPct.toFixed(0)}%)`,
				`hold ${interpolationHealth.holdingPrevious}  current ${interpolationHealth.currentSample}  missing ${interpolationHealth.missingCurrent}  clamped ${interpolationHealth.clamped}`,
				`workers ${freshWorkerStats.length}/${workerCount}  assigned ${workerAssigned}  updated ${workerUpdated}`,
				`loop avg ${avgLoopMs.toFixed(1)}ms  max ${maxLoopMs.toFixed(1)}ms  slow ${slowLoopCount}`
			].join('\n');
		}

		function removeMotionDebugOverlay() {
			if (!motionDebugOverlay) {
				return;
			}
			motionDebugOverlay.remove();
			motionDebugOverlay = undefined;
		}

		const orbitWorker = new Worker(new URL('./orbitWorker.js', import.meta.url), {
			type: 'module'
		});

		orbitWorker.postMessage({ type: 'init', satelliteData });

		const focusOrbitSampleCount = 720;
		const overlayOrbitSampleCount = 72;
		const orbitRefreshIntervalMs = 1000;
		let activeOrbitSatelliteIndex: number | undefined;
		let latestFocusOrbitRequestId = -1;
		let orbitRequestSequence = 0;
		let overlayOrbitGeneration = 0;
		let orbitRefreshIntervalId: number | undefined;
		let orbitLine: THREE.Line | undefined;
		let orbitOverlayMesh: THREE.LineSegments | undefined;
		let overlayRebuildScheduled = false;
		const orbitOverlayIndices = new Set<number>();
		const orbitOverlayPaths = new Map<number, Float32Array>();

		function nextOrbitRequestId() {
			orbitRequestSequence += 1;
			return orbitRequestSequence;
		}

		function disposeOrbitLine() {
			if (!orbitLine) {
				return;
			}
			scene.remove(orbitLine);
			orbitLine.geometry.dispose();
			(orbitLine.material as THREE.Material).dispose();
			orbitLine = undefined;
		}

		function disposeOrbitOverlayMesh() {
			if (!orbitOverlayMesh) {
				return;
			}
			scene.remove(orbitOverlayMesh);
			orbitOverlayMesh.geometry.dispose();
			(orbitOverlayMesh.material as THREE.Material).dispose();
			orbitOverlayMesh = undefined;
		}

		function disposeAllOrbitOverlayLines() {
			orbitOverlayIndices.clear();
			orbitOverlayPaths.clear();
			disposeOrbitOverlayMesh();
		}

		function createOrbitLine(
			orbitPoints: THREE.Vector3[],
			color: number,
			opacity: number,
			name: string
		) {
			const orbitGeometry = new THREE.BufferGeometry().setFromPoints(orbitPoints);
			const orbitMaterial = new THREE.LineBasicMaterial({
				color,
				opacity,
				transparent: true
			});
			orbitMaterial.depthWrite = false;
			orbitMaterial.depthTest = true;
			const newOrbitLine = new THREE.Line(orbitGeometry, orbitMaterial);
			newOrbitLine.name = name;
			newOrbitLine.renderOrder = 1;
			return newOrbitLine;
		}

		function rebuildOrbitOverlayMesh() {
			if (orbitOverlayPaths.size === 0) {
				disposeOrbitOverlayMesh();
				return;
			}
			let segmentCount = 0;
			for (const positions of orbitOverlayPaths.values()) {
				const points = positions.length / 3;
				if (points >= 2) {
					segmentCount += points - 1;
				}
			}
			if (segmentCount === 0) {
				disposeOrbitOverlayMesh();
				return;
			}
			const segmentPositions = new Float32Array(segmentCount * 2 * 3);
			let writeOffset = 0;
			for (const positions of orbitOverlayPaths.values()) {
				const points = positions.length / 3;
				if (points < 2) {
					continue;
				}
				for (let i = 0; i < points - 1; i++) {
					const from = i * 3;
					const to = (i + 1) * 3;
					segmentPositions[writeOffset++] = positions[from];
					segmentPositions[writeOffset++] = positions[from + 1];
					segmentPositions[writeOffset++] = positions[from + 2];
					segmentPositions[writeOffset++] = positions[to];
					segmentPositions[writeOffset++] = positions[to + 1];
					segmentPositions[writeOffset++] = positions[to + 2];
				}
			}
			const orbitGeometry = new THREE.BufferGeometry();
			orbitGeometry.setAttribute('position', new THREE.BufferAttribute(segmentPositions, 3));
			const orbitMaterial = new THREE.LineBasicMaterial({
				color: 0x9de3ff,
				opacity: 0.35,
				transparent: true
			});
			orbitMaterial.depthWrite = false;
			orbitMaterial.depthTest = true;
			const mesh = new THREE.LineSegments(orbitGeometry, orbitMaterial);
			mesh.name = 'orbitOverlayMesh';
			mesh.renderOrder = 1;
			disposeOrbitOverlayMesh();
			scene.add(mesh);
			orbitOverlayMesh = mesh;
		}

		function scheduleOrbitOverlayMeshRebuild() {
			if (overlayRebuildScheduled) {
				return;
			}
			overlayRebuildScheduled = true;
			requestAnimationFrame(() => {
				overlayRebuildScheduled = false;
				rebuildOrbitOverlayMesh();
			});
		}

		function requestOrbitUpdate() {
			if (activeOrbitSatelliteIndex === undefined) {
				return;
			}
			const requestId = nextOrbitRequestId();
			latestFocusOrbitRequestId = requestId;
			orbitWorker.postMessage({
				type: 'process',
				kind: 'focus',
				satelliteIndex: activeOrbitSatelliteIndex,
				requestId,
				startTimeMs: Date.now(),
				sampleCount: focusOrbitSampleCount,
				closeLoop: true,
				centerAroundStartTime: true
			});
		}

		function requestOverlayOrbit(satelliteIndex: number, generation: number) {
			orbitWorker.postMessage({
				type: 'process',
				kind: 'overlay',
				satelliteIndex,
				requestId: nextOrbitRequestId(),
				generation,
				startTimeMs: Date.now(),
				sampleCount: overlayOrbitSampleCount,
				closeLoop: true,
				centerAroundStartTime: true
			});
		}

		function pruneOrbitOverlayToVisible() {
			let changed = false;
			for (const satelliteIndex of [...orbitOverlayIndices]) {
				if (renderVisible[satelliteIndex] > 0) {
					continue;
				}
				orbitOverlayIndices.delete(satelliteIndex);
				orbitOverlayPaths.delete(satelliteIndex);
				changed = true;
			}
			if (changed) {
				scheduleOrbitOverlayMeshRebuild();
			}
		}

		function applyOrbitOverlay(noradCatIds: number[], mode: OrbitOverlayMode) {
			const targetIndices = new Set<number>();
			for (const noradCatId of noradCatIds) {
				const satelliteIndex = satelliteIndexByNoradId.get(noradCatId);
				if (satelliteIndex === undefined || renderVisible[satelliteIndex] === 0) {
					continue;
				}
				targetIndices.add(satelliteIndex);
			}

			overlayOrbitGeneration += 1;
			const generation = overlayOrbitGeneration;

			if (mode === 'replace') {
				let changed = false;
				for (const satelliteIndex of [...orbitOverlayIndices]) {
					if (targetIndices.has(satelliteIndex)) {
						continue;
					}
					orbitOverlayIndices.delete(satelliteIndex);
					orbitOverlayPaths.delete(satelliteIndex);
					changed = true;
				}
				for (const satelliteIndex of targetIndices) {
					orbitOverlayIndices.add(satelliteIndex);
					requestOverlayOrbit(satelliteIndex, generation);
				}
				if (changed || targetIndices.size === 0) {
					scheduleOrbitOverlayMeshRebuild();
				}
				return;
			}

			if (mode === 'add') {
				for (const satelliteIndex of targetIndices) {
					if (orbitOverlayIndices.has(satelliteIndex)) {
						continue;
					}
					orbitOverlayIndices.add(satelliteIndex);
					requestOverlayOrbit(satelliteIndex, generation);
				}
				return;
			}

			let changed = false;
			for (const satelliteIndex of targetIndices) {
				orbitOverlayIndices.delete(satelliteIndex);
				if (orbitOverlayPaths.delete(satelliteIndex)) {
					changed = true;
				}
			}
			if (changed) {
				scheduleOrbitOverlayMeshRebuild();
			}
		}

		function startOrbitTracking(satelliteIndex: number) {
			activeOrbitSatelliteIndex = satelliteIndex;
			disposeOrbitLine();
			requestOrbitUpdate();
			if (orbitRefreshIntervalId !== undefined) {
				window.clearInterval(orbitRefreshIntervalId);
			}
			orbitRefreshIntervalId = window.setInterval(requestOrbitUpdate, orbitRefreshIntervalMs);
		}

		function stopOrbitTracking() {
			activeOrbitSatelliteIndex = undefined;
			latestFocusOrbitRequestId = -1;
			if (orbitRefreshIntervalId !== undefined) {
				window.clearInterval(orbitRefreshIntervalId);
				orbitRefreshIntervalId = undefined;
			}
			disposeOrbitLine();
		}

		orbitWorker.onmessage = (event: MessageEvent<OrbitWorkerResponse>) => {
			const data = event.data;
			if (!data || data.type !== 'orbit-points') {
				return;
			}

			if (data.kind === 'focus') {
				if (data.requestId !== latestFocusOrbitRequestId) {
					return;
				}
				if (data.satelliteIndex !== activeOrbitSatelliteIndex) {
					return;
				}
				const orbitPoints = data.points.map(
					(point) => new THREE.Vector3(point.y, point.z, point.x)
				);
				if (orbitPoints.length < 2) {
					return;
				}
				disposeOrbitLine();
				const newOrbitLine = createOrbitLine(orbitPoints, 0x90ee90, 0.95, 'orbitLine');
				scene.add(newOrbitLine);
				orbitLine = newOrbitLine;
				return;
			}

			if (data.kind === 'overlay') {
				if (data.generation !== overlayOrbitGeneration) {
					return;
				}
				if (!orbitOverlayIndices.has(data.satelliteIndex)) {
					return;
				}
				if (!Array.isArray(data.points) || data.points.length < 2) {
					return;
				}
				const positions = new Float32Array(data.points.length * 3);
				let writeOffset = 0;
				for (const point of data.points) {
					positions[writeOffset++] = point.y;
					positions[writeOffset++] = point.z;
					positions[writeOffset++] = point.x;
				}
				orbitOverlayPaths.set(data.satelliteIndex, positions);
				scheduleOrbitOverlayMeshRebuild();
			}
		};

		const hermiteInterpolate = (
			p0: number,
			v0: number,
			p1: number,
			v1: number,
			t: number,
			deltaSeconds: number
		) => {
			const t2 = t * t;
			const t3 = t2 * t;
			const h00 = 2 * t3 - 3 * t2 + 1;
			const h10 = t3 - 2 * t2 + t;
			const h01 = -2 * t3 + 3 * t2;
			const h11 = t3 - t2;
			return h00 * p0 + h10 * deltaSeconds * v0 + h01 * p1 + h11 * deltaSeconds * v1;
		};

		const updateRenderPositionsFromSmoothedTrajectory = (nowMs: number) => {
			const renderTimeMs = nowMs - motionSmoothingDelayMs;
			let interpolating = 0;
			let holdingPrevious = 0;
			let currentSample = 0;
			let extrapolating = 0;
			let clamped = 0;
			let missingCurrent = 0;
			for (let i = 0; i < activeVisibleIndices.length; i++) {
				const satelliteIndex = activeVisibleIndices[i];
				const vectorIndex = satelliteIndex * 3;
				const previousTimeMs = satellitePreviousUpdateTimes[satelliteIndex];
				const currentTimeMs = satelliteCurrentUpdateTimes[satelliteIndex];

				if (currentTimeMs <= 0) {
					missingCurrent += 1;
					continue;
				}

				const hasPair = previousTimeMs > 0 && currentTimeMs > previousTimeMs;
				if (hasPair && renderTimeMs >= previousTimeMs && renderTimeMs <= currentTimeMs) {
					interpolating += 1;
					const spanMs = currentTimeMs - previousTimeMs;
					const normalizedT = (renderTimeMs - previousTimeMs) / spanMs;
					const spanSeconds = spanMs / 1000;
					satelliteRenderPositions[vectorIndex] = hermiteInterpolate(
						satellitePreviousPositions[vectorIndex],
						satellitePreviousVelocities[vectorIndex],
						satelliteCurrentPositions[vectorIndex],
						satelliteCurrentVelocities[vectorIndex],
						normalizedT,
						spanSeconds
					);
					satelliteRenderPositions[vectorIndex + 1] = hermiteInterpolate(
						satellitePreviousPositions[vectorIndex + 1],
						satellitePreviousVelocities[vectorIndex + 1],
						satelliteCurrentPositions[vectorIndex + 1],
						satelliteCurrentVelocities[vectorIndex + 1],
						normalizedT,
						spanSeconds
					);
					satelliteRenderPositions[vectorIndex + 2] = hermiteInterpolate(
						satellitePreviousPositions[vectorIndex + 2],
						satellitePreviousVelocities[vectorIndex + 2],
						satelliteCurrentPositions[vectorIndex + 2],
						satelliteCurrentVelocities[vectorIndex + 2],
						normalizedT,
						spanSeconds
					);
					continue;
				}

				if (renderTimeMs < previousTimeMs && previousTimeMs > 0) {
					holdingPrevious += 1;
					satelliteRenderPositions[vectorIndex] = satellitePreviousPositions[vectorIndex];
					satelliteRenderPositions[vectorIndex + 1] = satellitePreviousPositions[vectorIndex + 1];
					satelliteRenderPositions[vectorIndex + 2] = satellitePreviousPositions[vectorIndex + 2];
					continue;
				}

				let deltaSeconds = 0;
				if (renderTimeMs > currentTimeMs) {
					extrapolating += 1;
					const rawDeltaSeconds = Math.max(0, (renderTimeMs - currentTimeMs) / 1000);
					if (rawDeltaSeconds > maxExtrapolationSeconds) {
						clamped += 1;
					}
					deltaSeconds = Math.min(rawDeltaSeconds, maxExtrapolationSeconds);
				} else {
					currentSample += 1;
				}
				satelliteRenderPositions[vectorIndex] =
					satelliteCurrentPositions[vectorIndex] +
					satelliteCurrentVelocities[vectorIndex] * deltaSeconds;
				satelliteRenderPositions[vectorIndex + 1] =
					satelliteCurrentPositions[vectorIndex + 1] +
					satelliteCurrentVelocities[vectorIndex + 1] * deltaSeconds;
				satelliteRenderPositions[vectorIndex + 2] =
					satelliteCurrentPositions[vectorIndex + 2] +
					satelliteCurrentVelocities[vectorIndex + 2] * deltaSeconds;
			}
			interpolationHealth = {
				interpolating,
				holdingPrevious,
				currentSample,
				extrapolating,
				clamped,
				missingCurrent
			};
		};

		const refreshRenderVisibility = () => {
			const visibleIndices: number[] = [];
			let changed = false;
			for (let i = 0; i < N; i++) {
				if (renderReady[i] === 0 && satelliteCurrentUpdateTimes[i] > 0) {
					renderReady[i] = 1;
				}
				const nextRenderVisible = computeVisibility[i] > 0 && renderReady[i] > 0 ? 1 : 0;
				if (renderVisible[i] !== nextRenderVisible) {
					renderVisible[i] = nextRenderVisible;
					changed = true;
				}
				if (nextRenderVisible > 0) {
					visibleIndices.push(i);
				}
			}
			activeVisibleIndices = visibleIndices;
			if (changed) {
				geometry.attributes.visibility.needsUpdate = true;
			}
		};

		const assignComputeIndices = () => {
			const computeIndices: number[] = [];
			for (let i = 0; i < N; i++) {
				if (computeVisibility[i] > 0) {
					computeIndices.push(i);
				}
			}
			activeComputeIndices = computeIndices;
			const chunkSize = Math.ceil(computeIndices.length / workerCount) || 1;
			for (let workerIndex = 0; workerIndex < workerCount; workerIndex++) {
				const start = workerIndex * chunkSize;
				const end = start + chunkSize;
				satelliteWorkers[workerIndex].postMessage({
					type: 'set-indices',
					indices: computeIndices.slice(start, end)
				});
			}
		};

		satelliteWorkers.forEach((worker, workerIndex) => {
			worker.onmessage = (event: MessageEvent<WorkerLoopStatsMessage>) => {
				const data = event.data;
				if (!data || data.type !== 'loop-stats') {
					return;
				}
				workerLoopStats.set(data.workerId, {
					assignedCount: Number.isFinite(data.assignedCount) ? data.assignedCount : 0,
					updatedCount: Number.isFinite(data.updatedCount) ? data.updatedCount : 0,
					loopMs: Number.isFinite(data.loopMs) ? data.loopMs : 0,
					finishedAtMs: Number.isFinite(data.finishedAtMs) ? data.finishedAtMs : Date.now()
				});
			};
			worker.postMessage({
				type: 'init',
				previousSatellitePositions: satellitePreviousPositions,
				previousSatelliteVelocities: satellitePreviousVelocities,
				previousSatelliteUpdateTimes: satellitePreviousUpdateTimes,
				currentSatellitePositions: satelliteCurrentPositions,
				currentSatelliteVelocities: satelliteCurrentVelocities,
				currentSatelliteUpdateTimes: satelliteCurrentUpdateTimes,
				satelliteData,
				computeVisibility,
				workerId: workerIndex
			});
			worker.postMessage({
				type: 'set-update-interval',
				intervalMs: workerUpdateIntervalMs
			});
		});
		assignComputeIndices();

		const handleVisibilityChange = () => {
			const paused = document.hidden;
			satelliteWorkers.forEach((worker) => {
				worker.postMessage({
					type: 'set-paused',
					paused
				});
			});
		};
		document.addEventListener('visibilitychange', handleVisibilityChange);
		handleVisibilityChange();
		createMotionDebugOverlay();

		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.BufferAttribute(satelliteRenderPositions, 3));
		geometry.setAttribute('customColor', new THREE.BufferAttribute(colors, 3));
		geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
		geometry.setAttribute('visibility', new THREE.BufferAttribute(renderVisible, 1));
		const points = new THREE.Points(geometry, satelliteMaterial);
		points.renderOrder = 2;
		scene.add(points);

		function drawOrbit(satelliteIndex: number) {
			startOrbitTracking(satelliteIndex);
		}

		function removeVerticalLine() {
			scene.children.forEach((child) => {
				if (child.type === 'Line' && child.name === 'verticalLine') {
					scene.remove(child);
				}
			});
		}

		function drawVerticalLine(satelliteIndex: number) {
			removeVerticalLine();
			if (!renderVisible[satelliteIndex]) {
				return;
			}
			const material = new THREE.LineBasicMaterial({ color: 0x90ee90 });
			material.depthWrite = false;
			const points: THREE.Vector3[] = [];
			const satelliteVector = new THREE.Vector3(
				satelliteRenderPositions[satelliteIndex * 3],
				satelliteRenderPositions[satelliteIndex * 3 + 1],
				satelliteRenderPositions[satelliteIndex * 3 + 2]
			);
			const surfacePoint = satelliteVector
				.clone()
				.normalize()
				.multiplyScalar(earthRadius + lineSurfaceOffset);
			points.push(surfacePoint);
			points.push(satelliteVector);
			const geometry = new THREE.BufferGeometry().setFromPoints(points);
			const line = new THREE.Line(geometry, material);
			line.renderOrder = 1;
			line.name = 'verticalLine';
			scene.add(line);
		}

		function hoverColor() {
			raycaster.setFromCamera(mouse, camera);
			const intersects = raycaster.intersectObjects(scene.children, true);
			const index = intersects.findIndex((intersect) => intersect.object.type === 'Points');
			const color = geometry.attributes['customColor'] as THREE.BufferAttribute;
			let nextHoveredSatelliteIndex: number | undefined;
			let didChangeColor = false;

			if (index !== -1) {
				nextHoveredSatelliteIndex = intersects[index].index as number;
			}

			if (
				hoveredSatelliteIndex !== undefined &&
				(nextHoveredSatelliteIndex === undefined ||
					hoveredSatelliteIndex !== nextHoveredSatelliteIndex)
			) {
				resetPointColor(hoveredSatelliteIndex);
				didChangeColor = true;
			}

			if (
				nextHoveredSatelliteIndex !== undefined &&
				nextHoveredSatelliteIndex !== hoveredSatelliteIndex
			) {
				color.setXYZ(nextHoveredSatelliteIndex, 0.0, 1.0, 0.0);
				didChangeColor = true;
			}

			hoveredSatelliteIndex = nextHoveredSatelliteIndex;

			if (didChangeColor) {
				color.needsUpdate = true;
			}
		}
		let localSelectedSatellite: number | undefined;
		function clearSelectedSatelliteHighlight() {
			if (localSelectedSatellite === undefined) {
				return;
			}
			const color = geometry.attributes['customColor'] as THREE.BufferAttribute;
			color.setXYZ(localSelectedSatellite, 1.0, 1.0, 1.0);
			color.needsUpdate = true;
			localSelectedSatellite = undefined;
			removeVerticalLine();
		}

		function clearHoveredSatelliteHighlight() {
			if (hoveredSatelliteIndex === undefined) {
				return;
			}
			resetPointColor(hoveredSatelliteIndex);
			hoveredSatelliteIndex = undefined;
			const color = geometry.attributes['customColor'] as THREE.BufferAttribute;
			color.needsUpdate = true;
		}

		let mouseInsideScene = false;
		let hasMouseCoordinates = false;
		function onCanvasMouseEnter() {
			mouseInsideScene = true;
		}

		function onCanvasMouseLeave() {
			mouseInsideScene = false;
			clearHoveredSatelliteHighlight();
		}

		function resetPointColor(pointIndex: number) {
			const color = geometry.attributes['customColor'] as THREE.BufferAttribute;
			color.setXYZ(pointIndex, 1.0, 1.0, 1.0);
		}
		function handleShortClick(event: MouseEvent) {
			controls.minDistance = 0;

			mouse.x = (event.clientX / renderer.domElement.clientWidth) * 2 - 1;
			mouse.y = -(event.clientY / renderer.domElement.clientHeight) * 2 + 1;
			hasMouseCoordinates = true;

			raycaster.setFromCamera(mouse, camera);
			const intersects = raycaster.intersectObjects(scene.children, true);
			if (intersects.length > 0 && intersects[0].object.type === 'Line') {
				intersects.shift();
			}
			if (intersects.length > 0) {
				lerpTarget = undefined;
				trackTarget = undefined;
				if (intersects[0].object.type === 'Points') {
					const index = intersects[0].index as number;

					selectSatellite(index);
				} else if (intersects[0].object.type === 'Mesh') {
					clearSelectedSatelliteHighlight();
					lerpTarget = {
						type: 'body',
						indeces: undefined,
						position: intersects[0].object.position
					};
					selectedSatellite.set({
						name: 'Earth',
						details: ''
					});
				}
			}
		}

		function selectSatellite(index: number) {
			if (index < 0 || index >= N || !renderVisible[index]) {
				return;
			}
			// Reset active tracking so camera can lerp to the newly selected satellite.
			trackTarget = undefined;
			previousSatellitePosition = undefined;
			clearSelectedSatelliteHighlight();
			selectedSatellite.set({
				name: satellites[index].slice(-1)[0] + ' NORAD ID: ' + satelliteData[index].norad_cat_id,
				details: satellites[index][1] + '\n' + satellites[index][2],
				noradCatId: satelliteData[index].norad_cat_id,
				index: index,
				satrec: getSatelliteSatrec(index)
			});
			localSelectedSatellite = index;

			lerpTarget = {
				type: 'satellite',
				indeces: [index * 3, index * 3 + 1, index * 3 + 2],
				position: undefined
			};

			drawOrbit(index);
		}

		function focusEarth() {
			trackTarget = undefined;
			previousSatellitePosition = undefined;
			clearSelectedSatelliteHighlight();
			stopOrbitTracking();
			lerpTarget = { type: 'body', indeces: undefined, position: new THREE.Vector3(0, 0, 0) };
			selectedSatellite.set({
				name: 'Earth',
				details: ''
			});
			return true;
		}

		function focusVisibleNoradId(noradCatId: number) {
			if (!Number.isInteger(noradCatId) || noradCatId <= 0) {
				return false;
			}
			const index = satelliteIndexByNoradId.get(noradCatId);
			if (index === undefined || renderVisible[index] === 0) {
				return false;
			}
			selectSatellite(index);
			return true;
		}

		function selectRelativeVisibleSatellite(step: -1 | 1) {
			if (activeVisibleIndices.length === 0) {
				return;
			}
			let selectedPosition = -1;
			if (localSelectedSatellite !== undefined) {
				selectedPosition = activeVisibleIndices.indexOf(localSelectedSatellite);
			}
			if (selectedPosition === -1) {
				const fallbackIndex =
					step > 0
						? activeVisibleIndices[0]
						: activeVisibleIndices[activeVisibleIndices.length - 1];
				selectSatellite(fallbackIndex);
				return;
			}
			const nextPosition =
				(selectedPosition + step + activeVisibleIndices.length) % activeVisibleIndices.length;
			selectSatellite(activeVisibleIndices[nextPosition]);
		}

		function updateMouseCoordinates(event: MouseEvent) {
			mouse.x = (event.clientX / renderer.domElement.clientWidth) * 2 - 1;
			mouse.y = -(event.clientY / renderer.domElement.clientHeight) * 2 + 1;
			hasMouseCoordinates = true;
		}
		let startTime: number;
		let mouseDownEvent: MouseEvent | undefined;
		function onMouseDown(event: MouseEvent) {
			mouseDownEvent = event;
			startTime = new Date().getTime();
		}
		let lerpTarget:
			| { type: string; indeces: Array<number> | undefined; position: THREE.Vector3 | undefined }
			| undefined;
		let trackTarget: Array<number> | undefined;
		let duration: number;
		function onMouseUp() {
			duration = new Date().getTime() - startTime;
		}

		function onClick() {
			const shortClickDuration = 230;
			if (duration < shortClickDuration && mouseDownEvent) {
				handleShortClick(mouseDownEvent);
			}
		}

		const lerpToTarget = (target: THREE.Vector3) => {
			trackTarget = undefined;
			controls.target.lerp(target, 0.1);
		};

		let previousSatellitePosition: THREE.Vector3 | undefined;

		const trackToTarget = (target: THREE.Vector3) => {
			if (!previousSatellitePosition) {
				previousSatellitePosition = target.clone();
				return;
			}

			if (previousSatellitePosition) {
				controls.target.set(target.x, target.y, target.z);
				const movementVector = new THREE.Vector3().subVectors(target, previousSatellitePosition);
				// camera.position.add(movementVector);
				previousSatellitePosition = target.clone();
				const cameraposition = camera.position.clone();
				if (movementVector.length() < 2) {
					camera.position.set(
						cameraposition.x + movementVector.x,
						cameraposition.y + movementVector.y,
						cameraposition.z + movementVector.z
					);
				}
			}
		};

		const clearSelectionIfHidden = () => {
			if (localSelectedSatellite === undefined || renderVisible[localSelectedSatellite] > 0) {
				return;
			}
			trackTarget = undefined;
			lerpTarget = undefined;
			previousSatellitePosition = undefined;
			clearSelectedSatelliteHighlight();
			stopOrbitTracking();
		};

		const unsubscribeSharedData = sharedData.subscribe((data: SharedSceneData) => {
			if (data.length === 0) {
				return;
			}
			const selectedNoradIds = new Set(data[0].map((item: QueryResultRow) => item.NORAD_CAT_ID));
			if (data[1] === 'replace') {
				for (let i = 0; i < N; i++) {
					const noradID = satelliteData[i].norad_cat_id;
					if (selectedNoradIds.has(noradID)) {
						computeVisibility[i] = 1.0;
					} else {
						computeVisibility[i] = 0.0;
					}
				}
				refreshRenderVisibility();
			} else if (data[1] === 'add') {
				for (let i = 0; i < N; i++) {
					const noradID = satelliteData[i].norad_cat_id;
					if (selectedNoradIds.has(noradID)) {
						computeVisibility[i] = 1.0;
					}
				}
				refreshRenderVisibility();
			} else if (data[1] === 'remove') {
				for (let i = 0; i < N; i++) {
					const noradID = satelliteData[i].norad_cat_id;
					if (selectedNoradIds.has(noradID)) {
						computeVisibility[i] = 0.0;
					}
				}
				refreshRenderVisibility();
			}
			assignComputeIndices();
			pruneOrbitOverlayToVisible();
			clearSelectionIfHidden();
		});
		// line to center
		// const lineGeometry = new THREE.LineGeometry();

		let lastHoverCheckTs = 0;
		const hoverCheckIntervalMs = 180;
		satelliteFrameUpdate = (currentTime: number) => {
			refreshRenderVisibility();
			updateRenderPositionsFromSmoothedTrajectory(Date.now());
			updateMotionDebugOverlay(currentTime);
			geometry.attributes.position.needsUpdate = true;
			if (
				mouseInsideScene &&
				hasMouseCoordinates &&
				currentTime - lastHoverCheckTs > hoverCheckIntervalMs
			) {
				hoverColor();
				lastHoverCheckTs = currentTime;
			}
			if (lerpTarget && !trackTarget) {
				if (lerpTarget.type === 'satellite' && lerpTarget.indeces) {
					const lerpTargetVector = new THREE.Vector3(
						satelliteRenderPositions[lerpTarget.indeces[0]],
						satelliteRenderPositions[lerpTarget.indeces[1]],
						satelliteRenderPositions[lerpTarget.indeces[2]]
					);
					lerpToTarget(lerpTargetVector);
					if (controls.target.distanceTo(lerpTargetVector) < 1.5) {
						controls.target = lerpTargetVector;
						trackTarget = lerpTarget.indeces;
						lerpTarget = undefined;
					}
				} else if (lerpTarget.type === 'body' && lerpTarget.position) {
					lerpToTarget(lerpTarget.position);
					if (controls.target.distanceTo(lerpTarget.position) < 1) {
						trackTarget = undefined;
						lerpTarget = undefined;
					}
				}
			} else if (trackTarget) {
				const trackTargetVector = new THREE.Vector3(
					satelliteRenderPositions[trackTarget[0]],
					satelliteRenderPositions[trackTarget[1]],
					satelliteRenderPositions[trackTarget[2]]
				);
				trackToTarget(trackTargetVector);
			}
			if (localSelectedSatellite !== undefined) {
				drawVerticalLine(localSelectedSatellite);
			}
		};

		window.addEventListener('mousemove', updateMouseCoordinates);
		window.addEventListener('mousedown', onMouseDown, false);
		window.addEventListener('mouseup', onMouseUp, false);
		window.addEventListener('click', onClick, false);
		renderer.domElement.addEventListener('mouseenter', onCanvasMouseEnter);
		renderer.domElement.addEventListener('mouseleave', onCanvasMouseLeave);
		cleanupSatellites = () => {
			satelliteFrameUpdate = () => {};
			satelliteWorkers.forEach((worker) => worker.terminate());
			stopOrbitTracking();
			disposeAllOrbitOverlayLines();
			orbitWorker.terminate();
			unsubscribeSharedData();
			document.removeEventListener('visibilitychange', handleVisibilityChange);
			removeMotionDebugOverlay();
			window.removeEventListener('mousemove', updateMouseCoordinates);
			window.removeEventListener('mousedown', onMouseDown);
			window.removeEventListener('mouseup', onMouseUp);
			window.removeEventListener('click', onClick);
			renderer.domElement.removeEventListener('mouseenter', onCanvasMouseEnter);
			renderer.domElement.removeEventListener('mouseleave', onCanvasMouseLeave);
		};
		focusPreviousVisibleSatelliteImpl = () => selectRelativeVisibleSatellite(-1);
		focusNextVisibleSatelliteImpl = () => selectRelativeVisibleSatellite(1);
		getVisibleCountImpl = () => activeVisibleIndices.length;
		focusEarthImpl = focusEarth;
		focusVisibleNoradIdImpl = focusVisibleNoradId;
		applyOrbitOverlayImpl = applyOrbitOverlay;
	};

	const animate = () => {
		const onAnimationFrame = () => {
			if (showSceneDebug) {
				stats.update();
			}
			const currentTime = new Date().getTime();
			earthMesh.rotation.y =
				gmstAtReferenceTimeRad + getEarthRotationAtTimeRad(currentTime) + textureAlignmentOffsetRad;
			satelliteFrameUpdate(currentTime);
			controls.update();
			renderer.render(scene, camera);
			animationFrameId = requestAnimationFrame(onAnimationFrame);
		};
		animationFrameId = requestAnimationFrame(onAnimationFrame);
	};

	resize();
	window.addEventListener('resize', resize);
	animate();

	return {
		textureReady,
		loadSatellites,
		cleanup: () => {
			disposed = true;
			cancelAnimationFrame(animationFrameId);
			cleanupSatellites();
			if (stats.dom.isConnected) {
				stats.dom.remove();
			}
			if (axesHelper) {
				scene.remove(axesHelper);
				axesHelper = undefined;
			}
			window.removeEventListener('resize', resize);
		},
		focusPreviousVisibleSatellite: () => focusPreviousVisibleSatelliteImpl(),
		focusNextVisibleSatellite: () => focusNextVisibleSatelliteImpl(),
		getVisibleCount: () => getVisibleCountImpl(),
		focusEarth: () => focusEarthImpl(),
		focusVisibleNoradId: (noradCatId: number) => focusVisibleNoradIdImpl(noradCatId),
		applyOrbitOverlay: (noradCatIds: number[], mode: OrbitOverlayMode) =>
			applyOrbitOverlayImpl(noradCatIds, mode)
	};
};
