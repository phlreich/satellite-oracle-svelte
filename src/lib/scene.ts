import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { twoline2satrec, gstime, geodeticToEcf, ecfToEci } from 'satellite.js';
import Stats from 'three/examples/jsm/libs/stats.module.js';
import type { Writable } from 'svelte/store';
import { base } from '$app/paths';

type SceneDataRow = [string, string, string, number, string];
type QueryResultRow = { NORAD_CAT_ID: number };
type SharedSceneData = [QueryResultRow[], 'show_objects' | 'draw_orbits'] | [];
type OrbitWorkerPoint = { x: number; y: number; z: number };
type OrbitWorkerResponse = {
	type: 'orbit-points';
	requestId: number;
	satelliteIndex: number;
	points: OrbitWorkerPoint[];
};
type SelectedSatelliteState = {
	name: string;
	details: object | string;
	latitude?: number;
	longitude?: number;
	index?: number;
	satrec?: unknown;
} | null;
type SceneController = {
	cleanup: () => void;
	focusPreviousVisibleSatellite: () => void;
	focusNextVisibleSatellite: () => void;
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
	return ((timeElapsed % oneSiderealDayInMilliseconds) / oneSiderealDayInMilliseconds) * Math.PI * 2;
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
textureLoader.load(`${base}/earth.webp`, (texture) => {
	texture.colorSpace = THREE.SRGBColorSpace;
	earthMesh.material = new THREE.MeshBasicMaterial({ map: texture });
	earthMesh.material.needsUpdate = true;
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

// axes helper
// const axesHelper = new THREE.AxesHelper(10000);
// scene.add(axesHelper);

const stats = new Stats();
if (import.meta.env.DEV) {
	document.body.appendChild(stats.dom);
}

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

export const createScene = async (
	el: HTMLCanvasElement,
	satellites: SceneDataRow[],
	selectedSatellite: Writable<SelectedSatelliteState>,
	sharedData: Writable<SharedSceneData>
): Promise<SceneController> => {
	let audioFlag = false;
	const playAudio = () => {
		audioFlag = false;
		const audio = new Audio(`${base}/threnody.mp3`);
		audio.play();
	};

	const raycaster = new THREE.Raycaster();
	raycaster.params.Points = { threshold: 20 };
	const mouse = new THREE.Vector2();

	let hoveredSatelliteIndex: number | undefined;
	renderer = new THREE.WebGLRenderer({ antialias: true, canvas: el });
	const controls = new OrbitControls(camera, renderer.domElement);
	controls.enableDamping = true;
	controls.dampingFactor = 0.1;

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

	// initialize satellite positions
	const N = satellites.length;
	const sharedBufferTargetPositions = new SharedArrayBuffer(N * 3 * Float32Array.BYTES_PER_ELEMENT);
	const sharedBufferTargetVelocities = new SharedArrayBuffer(
		N * 3 * Float32Array.BYTES_PER_ELEMENT
	);
	const sharedBufferUpdateTimes = new SharedArrayBuffer(N * Float64Array.BYTES_PER_ELEMENT);
	const sharedBuffervisibility = new SharedArrayBuffer(N * 1 * Uint8Array.BYTES_PER_ELEMENT);
	const satelliteTargetPositions = new Float32Array(sharedBufferTargetPositions);
	const satelliteTargetVelocities = new Float32Array(sharedBufferTargetVelocities);
	const satelliteUpdateTimes = new Float64Array(sharedBufferUpdateTimes);
	const satelliteRenderPositions = new Float32Array(N * 3);
	let activeVisibleIndices: number[] = [];
	const visibility = new Uint8Array(sharedBuffervisibility);

	const colors = new Float32Array(N * 3); // three components per color
	const sizes = new Float32Array(N); // one component per size
	for (let i = 0; i < N; i++) {
		colors[i * 3] = 1.0; // red
		colors[i * 3 + 1] = 1.0; // green
		colors[i * 3 + 2] = 1.0; // blue
		sizes[i] = 2000; // size
	}

	// Show all loaded objects by default.
	visibility.fill(1);

	const satelliteData = satellites.map((sat: SceneDataRow) => {
		const [epoch, tleLine1, tleLine2, norad_cat_id] = sat;
		const satrec = twoline2satrec(tleLine1, tleLine2);
		const epochDate = new Date(epoch);
		return { satrec, epoch: epochDate, norad_cat_id };
	});
	const workerUpdateIntervalMs = 250;
	const workerCount = Math.max(
		1,
		Math.min(4, Math.floor((navigator.hardwareConcurrency ?? 4) / 2) || 1)
	);
	const satelliteWorkers = Array.from({ length: workerCount }, () => {
		return new Worker(new URL('./satelliteWorker.js', import.meta.url), { type: 'module' });
	});

	const orbitWorker = new Worker(new URL('./orbitWorker.js', import.meta.url), { type: 'module' });

	orbitWorker.postMessage({ type: 'init', satelliteData });

	const orbitSampleCount = 720;
	const orbitRefreshIntervalMs = 1000;
	let activeOrbitSatelliteIndex: number | undefined;
	let latestOrbitRequestId = 0;
	let orbitRefreshIntervalId: number | undefined;
	let orbitLine: THREE.Line | undefined;

	function disposeOrbitLine() {
		if (!orbitLine) {
			return;
		}
		scene.remove(orbitLine);
		orbitLine.geometry.dispose();
		(orbitLine.material as THREE.Material).dispose();
		orbitLine = undefined;
	}

	function requestOrbitUpdate() {
		if (activeOrbitSatelliteIndex === undefined) {
			return;
		}
		latestOrbitRequestId += 1;
		orbitWorker.postMessage({
			type: 'process',
			satelliteIndex: activeOrbitSatelliteIndex,
			requestId: latestOrbitRequestId,
			startTimeMs: Date.now(),
			sampleCount: orbitSampleCount,
			closeLoop: true,
			centerAroundStartTime: true
		});
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
		latestOrbitRequestId += 1;
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
		if (data.requestId !== latestOrbitRequestId) {
			return;
		}
		if (data.satelliteIndex !== activeOrbitSatelliteIndex) {
			return;
		}
		const orbitPoints = data.points.map((point) => new THREE.Vector3(point.y, point.z, point.x));
		if (orbitPoints.length < 2) {
			return;
		}
		disposeOrbitLine();
		const orbitGeometry = new THREE.BufferGeometry().setFromPoints(orbitPoints);
		const orbitMaterial = new THREE.LineBasicMaterial({
			color: 0x90ee90,
			opacity: 0.95,
			transparent: true
		});
		orbitMaterial.depthWrite = false;
		orbitMaterial.depthTest = true;
		const newOrbitLine = new THREE.Line(orbitGeometry, orbitMaterial);
		newOrbitLine.name = 'orbitLine';
		newOrbitLine.renderOrder = 1;
		scene.add(newOrbitLine);
		orbitLine = newOrbitLine;
	};

	const extrapolateFromVelocity = (nowMs: number) => {
		const maxExtrapolationSeconds = (workerUpdateIntervalMs * 2) / 1000;
		for (let i = 0; i < activeVisibleIndices.length; i++) {
			const index = activeVisibleIndices[i] * 3;
			const updateTimeMs = satelliteUpdateTimes[activeVisibleIndices[i]];
			let deltaSeconds = 0;
			if (updateTimeMs > 0) {
				deltaSeconds = Math.max(0, (nowMs - updateTimeMs) / 1000);
				deltaSeconds = Math.min(deltaSeconds, maxExtrapolationSeconds);
			}
			satelliteRenderPositions[index] =
				satelliteTargetPositions[index] + satelliteTargetVelocities[index] * deltaSeconds;
			satelliteRenderPositions[index + 1] =
				satelliteTargetPositions[index + 1] + satelliteTargetVelocities[index + 1] * deltaSeconds;
			satelliteRenderPositions[index + 2] =
				satelliteTargetPositions[index + 2] + satelliteTargetVelocities[index + 2] * deltaSeconds;
		}
	};

	const assignVisibleIndices = () => {
		const visibleIndices: number[] = [];
		for (let i = 0; i < N; i++) {
			if (visibility[i] > 0) {
				visibleIndices.push(i);
			}
		}
		activeVisibleIndices = visibleIndices;
		const chunkSize = Math.ceil(visibleIndices.length / workerCount) || 1;
		for (let workerIndex = 0; workerIndex < workerCount; workerIndex++) {
			const start = workerIndex * chunkSize;
			const end = start + chunkSize;
			satelliteWorkers[workerIndex].postMessage({
				type: 'set-indices',
				indices: visibleIndices.slice(start, end)
			});
		}
	};

	satelliteWorkers.forEach((worker) => {
		worker.postMessage({
			type: 'init',
			satellitepositions: satelliteTargetPositions,
			satellitevelocities: satelliteTargetVelocities,
			satelliteupdatetimes: satelliteUpdateTimes,
			satelliteData,
			visibility
		});
		worker.postMessage({
			type: 'set-update-interval',
			intervalMs: workerUpdateIntervalMs
		});
	});
	assignVisibleIndices();

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

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(satelliteRenderPositions, 3));
	geometry.setAttribute('customColor', new THREE.BufferAttribute(colors, 3));
	geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
	geometry.setAttribute('visibility', new THREE.BufferAttribute(visibility, 1));
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
		if (!visibility[satelliteIndex]) {
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
				lerpTarget = { type: 'body', indeces: undefined, position: intersects[0].object.position };
				selectedSatellite.set({
					name: 'Earth',
					details: ''
				});
			}
		}
	}

	function selectSatellite(index: number) {
		if (index < 0 || index >= N || !visibility[index]) {
			return;
		}
		// Reset active tracking so camera can lerp to the newly selected satellite.
		trackTarget = undefined;
		previousSatellitePosition = undefined;
		clearSelectedSatelliteHighlight();
		selectedSatellite.set({
			name: satellites[index].slice(-1)[0] + ' NORAD ID: ' + satelliteData[index].norad_cat_id,
			details: satellites[index][1] + '\n' + satellites[index][2],
			index: index,
			satrec: satelliteData[index].satrec
		});
		localSelectedSatellite = index;

		lerpTarget = {
			type: 'satellite',
			indeces: [index * 3, index * 3 + 1, index * 3 + 2],
			position: undefined
		};

		drawOrbit(index);
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
				step > 0 ? activeVisibleIndices[0] : activeVisibleIndices[activeVisibleIndices.length - 1];
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
		if (audioFlag) {
			playAudio();
		}
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

	sharedData.subscribe((data: SharedSceneData) => {
		if (data.length === 0) {
			return;
		}
		const selectedNoradIds = new Set(data[0].map((item: QueryResultRow) => item.NORAD_CAT_ID));
		if (data[1] === 'show_objects') {
			for (let i = 0; i < N; i++) {
				const noradID = satelliteData[i].norad_cat_id;
				if (selectedNoradIds.has(noradID)) {
					visibility[i] = 1.0;
				} else {
					visibility[i] = 0.0;
				}
			}
			geometry.attributes.visibility.needsUpdate = true;
		} else if (data[1] === 'draw_orbits') {
			for (let i = 0; i < N; i++) {
				const noradID = satelliteData[i].norad_cat_id;
				if (selectedNoradIds.has(noradID)) {
					visibility[i] = 1.0;
				}
			}
		}
		assignVisibleIndices();
	});
	// line to center
	// const lineGeometry = new THREE.LineGeometry();

	let lastHoverCheckTs = 0;
	const hoverCheckIntervalMs = 180;

	const animate = () => {
		const onAnimationFrame = async () => {
			if (import.meta.env.DEV) {
				stats.update();
			}
			const currentTime = new Date().getTime();
			earthMesh.rotation.y =
				gmstAtReferenceTimeRad + getEarthRotationAtTimeRad(currentTime) + textureAlignmentOffsetRad;

			extrapolateFromVelocity(Date.now());
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
			controls.update();
			renderer.render(scene, camera);
			animationFrameId = requestAnimationFrame(onAnimationFrame);
		};
		animationFrameId = requestAnimationFrame(onAnimationFrame);
	};
	resize();
	// TODO find out why removing the following line breaks hovercolor and click
	await new Promise((r) => setTimeout(r, 1000));
	satelliteRenderPositions.set(satelliteTargetPositions);
	animate();

	window.addEventListener('mousemove', updateMouseCoordinates);
	window.addEventListener('mousedown', onMouseDown, false);
	window.addEventListener('mouseup', onMouseUp, false);
	window.addEventListener('click', onClick, false);
	renderer.domElement.addEventListener('mouseenter', onCanvasMouseEnter);
	renderer.domElement.addEventListener('mouseleave', onCanvasMouseLeave);
	// Return cleanup function
	return {
		cleanup: () => {
			cancelAnimationFrame(animationFrameId); // Cancel the animation loop
			satelliteWorkers.forEach((worker) => worker.terminate());
			stopOrbitTracking();
			orbitWorker.terminate();
			document.removeEventListener('visibilitychange', handleVisibilityChange);
			window.removeEventListener('resize', resize);
			window.removeEventListener('mousemove', updateMouseCoordinates);
			window.removeEventListener('mousedown', onMouseDown);
			window.removeEventListener('mouseup', onMouseUp);
			window.removeEventListener('click', onClick);
			renderer.domElement.removeEventListener('mouseenter', onCanvasMouseEnter);
			renderer.domElement.removeEventListener('mouseleave', onCanvasMouseLeave);
		},
		focusPreviousVisibleSatellite: () => selectRelativeVisibleSatellite(-1),
		focusNextVisibleSatellite: () => selectRelativeVisibleSatellite(1)
	};
};

window.addEventListener('resize', resize);
