import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { twoline2satrec, gstime } from 'satellite.js';
import Stats from 'three/examples/jsm/libs/stats.module.js';
import type { Writable } from 'svelte/store';
import { base } from '$app/paths';

type SceneDataRow = [string, string, string, number, string];
type QueryResultRow = { NORAD_CAT_ID: number };
type SharedSceneData = [QueryResultRow[], 'show_objects' | 'draw_orbits'] | [];
type SelectedSatelliteState = {
	name: string;
	details: object | string;
	latitude?: number;
	longitude?: number;
	index?: number;
	satrec?: unknown;
} | null;

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
document.body.appendChild(stats.dom);

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
) => {
	let audioFlag = false;
	const playAudio = () => {
		audioFlag = false;
		const audio = new Audio(`${base}/threnody.mp3`);
		audio.play();
	};

	const raycaster = new THREE.Raycaster();
	raycaster.params.Points = { threshold: 20 };
	const mouse = new THREE.Vector2();

	let lastIntersect: number | undefined;
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

	// initialize satellite positions
	const N = satellites.length;
	const sharedBufferPositions = new SharedArrayBuffer(N * 3 * Float32Array.BYTES_PER_ELEMENT);
	const sharedBuffervisibility = new SharedArrayBuffer(N * 1 * Uint8Array.BYTES_PER_ELEMENT);
	const satellitepositions = new Float32Array(sharedBufferPositions);
	const visibility = new Uint8Array(sharedBuffervisibility);

	const colors = new Float32Array(N * 3); // three components per color
	const sizes = new Float32Array(N); // one component per size
	for (let i = 0; i < N; i++) {
		colors[i * 3] = 1.0; // red
		colors[i * 3 + 1] = 1.0; // green
		colors[i * 3 + 2] = 1.0; // blue
		sizes[i] = 2000; // size
	}

	visibility.fill(1.0, 0, 3333);

	const satelliteData = satellites.map((sat: SceneDataRow) => {
		const [epoch, tleLine1, tleLine2, norad_cat_id] = sat;
		const satrec = twoline2satrec(tleLine1, tleLine2);
		const epochDate = new Date(epoch);
		return { satrec, epoch: epochDate, norad_cat_id };
	});
	const workerCount = Math.max(2, Math.min(8, navigator.hardwareConcurrency ?? 4));
	const satelliteWorkers = Array.from({ length: workerCount }, () => {
		return new Worker(new URL('./satelliteWorker.js', import.meta.url), { type: 'module' });
	});

	const orbitWorker = new Worker(new URL('./orbitWorker.js', import.meta.url), { type: 'module' });

	orbitWorker.postMessage({ type: 'init', satelliteData, satellites });

	const assignVisibleIndices = () => {
		const visibleIndices: number[] = [];
		for (let i = 0; i < N; i++) {
			if (visibility[i] > 0) {
				visibleIndices.push(i);
			}
		}
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
			satellitepositions,
			satelliteData,
			visibility
		});
	});
	assignVisibleIndices();

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(satellitepositions, 3));
	geometry.setAttribute('customColor', new THREE.BufferAttribute(colors, 3));
	geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
	geometry.setAttribute('visibility', new THREE.BufferAttribute(visibility, 1));
	const points = new THREE.Points(geometry, satelliteMaterial);
	points.renderOrder = 2;
	scene.add(points);

	function drawOrbit(satelliteIndex: number) {
		deleteOrbits();
		orbitWorker.postMessage({ type: 'process', satelliteIndex });
		orbitWorker.onmessage = (event) => {
			const orbitPoints = event.data.map(
				(point: { x: number; y: number; z: number }) => new THREE.Vector3(point.y, point.z, point.x)
			);
			const geometry = new THREE.BufferGeometry().setFromPoints(orbitPoints);
			const material = new THREE.LineBasicMaterial({ color: 0x90ee90 });
			material.depthWrite = false;
			const orbit = new THREE.Line(geometry, material);
			orbit.renderOrder = 1;
			scene.add(orbit);
		};
	}

	function drawVerticalLine(satelliteIndex: number) {
		scene.children.forEach((child) => {
			if (child.type === 'Line' && child.name === 'verticalLine') {
				scene.remove(child);
			}
		});
		if (!visibility[satelliteIndex]) {
			return;
		}
		const material = new THREE.LineBasicMaterial({ color: 0x90ee90 });
		material.depthWrite = false;
		const points: THREE.Vector3[] = [];
		const satelliteVector = new THREE.Vector3(
			satellitepositions[satelliteIndex * 3],
			satellitepositions[satelliteIndex * 3 + 1],
			satellitepositions[satelliteIndex * 3 + 2]
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

		if (index !== -1) {
			const satelliteIndex = intersects[index].index as number;
			const color = geometry.attributes['customColor'] as THREE.BufferAttribute;
			color.setXYZ(satelliteIndex, 0.0, 1.0, 0.0);
			color.needsUpdate = true;
			if (lastIntersect !== undefined) {
				if (lastIntersect !== satelliteIndex) {
					resetLast(lastIntersect);
				}
			}
			lastIntersect = satelliteIndex;
		} else {
			if (lastIntersect !== undefined) {
				resetLast(lastIntersect);
			}
			lastIntersect = undefined;
		}
	}
	let localSelectedSatellite: number | undefined;
	function handleShortClick(event: MouseEvent) {
		controls.minDistance = 0;

		mouse.x = (event.clientX / renderer.domElement.clientWidth) * 2 - 1;
		mouse.y = -(event.clientY / renderer.domElement.clientHeight) * 2 + 1;

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
				lerpTarget = { type: 'body', indeces: undefined, position: intersects[0].object.position };
				selectedSatellite.set({
					name: 'Earth',
					details: ''
				});
			}
		}
	}

	function selectSatellite(index: number) {
		const color = geometry.attributes['customColor'] as THREE.BufferAttribute;
		color.setXYZ(index, 1.0, 0.0, 0.0);
		selectedSatellite.set({
			name: satellites[index].slice(-1)[0] + ' NORAD ID: ' + satelliteData[index].norad_cat_id,
			details: satellites[index][1] + '\n' + satellites[index][2],
			index: index,
			satrec: satelliteData[index].satrec
		});
		localSelectedSatellite = index;
		color.needsUpdate = true;

		lerpTarget = {
			type: 'satellite',
			indeces: [index * 3, index * 3 + 1, index * 3 + 2],
			position: undefined
		};
		lastIntersect = index;

		drawOrbit(index);
	}

	function resetLast(lastIntersect: number) {
		// if the camera is not looking at the point, reset the color
		const color = geometry.attributes['customColor'] as THREE.BufferAttribute;
		color.setXYZ(lastIntersect, 1.0, 1.0, 1.0);
		color.needsUpdate = true;
	}

	function updateMouseCoordinates(event: MouseEvent) {
		mouse.x = (event.clientX / renderer.domElement.clientWidth) * 2 - 1;
		mouse.y = -(event.clientY / renderer.domElement.clientHeight) * 2 + 1;
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
		if (data[1] === 'show_objects') {
			for (let i = 0; i < N; i++) {
				const noradID = satelliteData[i].norad_cat_id;
				// Check if noradID is present in any of the objects in data[0]
				if (data[0].some((item: QueryResultRow) => item.NORAD_CAT_ID === noradID)) {
					visibility[i] = 1.0;
				} else {
					visibility[i] = 0.0;
				}
			}
			geometry.attributes.visibility.needsUpdate = true;
		} else if (data[1] === 'draw_orbits') {
			for (let i = 0; i < N; i++) {
				const noradID = satelliteData[i].norad_cat_id;
				// Check if noradID is present in any of the objects in data[0]
				if (data[0].some((item: QueryResultRow) => item.NORAD_CAT_ID === noradID)) {
					visibility[i] = 1.0;
					// console.log('drawing orbit for', noradID);
					drawOrbit(i);
				}
			}
		}
		assignVisibleIndices();
		deleteOrbits();
	});

	function deleteOrbits() {
		scene.children.forEach((child) => {
			if (child.type === 'Line') {
				scene.remove(child);
			}
		});
	}
	// line to center
	// const lineGeometry = new THREE.LineGeometry();

	// Constants for Earth's rotation
	const oneSiderealDayInMilliseconds = 86164.0916 * 1000; // Sidereal day in milliseconds
	const referenceTime = new Date().setUTCHours(0, 0, 0, 0); // Midnight UTC as a reference start point

	// Calculate GMST at the reference time (midnight UTC)
	const refDateObject = new Date(referenceTime);
	const gmstAtReferenceTimeRad = gstime(refDateObject); // Re-enabled

	// This constant is used to align the texture's Prime Meridian (0° longitude)
	// with the direction of the vernal equinox in the Three.js scene when GMST is 0.
	// Based on: Earth's Prime Meridian on texture is +X at rotation.y=0
	// Vernal Equinox direction in Three.js scene is +Z.
	// Rotation from +X to +Z around Y is -90 degrees.
	const textureAlignmentOffsetRad = -Math.PI / 2; // Was previously commented out or a different value

	const animate = () => {
		const onAnimationFrame = async () => {
			stats.update();
			const currentTime = new Date().getTime(); // Re-enabled
			const timeElapsed = currentTime - referenceTime; // Re-enabled

			// Calculate the Earth's dynamic rotation since the referenceTime
			const dynamicRotationSinceRefTimeDeg =
				((timeElapsed % oneSiderealDayInMilliseconds) / oneSiderealDayInMilliseconds) * 360; // Re-enabled
			const dynamicRotationSinceRefTimeRad = THREE.MathUtils.degToRad(
				dynamicRotationSinceRefTimeDeg
			); // Re-enabled

			// Current GMST = GMST at reference time + dynamic rotation since reference time
			const currentGmstRad = gmstAtReferenceTimeRad + dynamicRotationSinceRefTimeRad; // Re-enabled

			// Apply GMST and the texture alignment offset
			earthMesh.rotation.y = currentGmstRad + textureAlignmentOffsetRad; // Corrected logic

			earthGeometry.attributes.position.needsUpdate = true;
			geometry.attributes.position.needsUpdate = true;
			hoverColor();
			if (lerpTarget && !trackTarget) {
				if (lerpTarget.type === 'satellite' && lerpTarget.indeces) {
					const lerpTargetVector = new THREE.Vector3(
						satellitepositions[lerpTarget.indeces[0]],
						satellitepositions[lerpTarget.indeces[1]],
						satellitepositions[lerpTarget.indeces[2]]
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
					satellitepositions[trackTarget[0]],
					satellitepositions[trackTarget[1]],
					satellitepositions[trackTarget[2]]
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
	animate();

	window.addEventListener('mousemove', updateMouseCoordinates);
	window.addEventListener('mousedown', onMouseDown, false);
	window.addEventListener('mouseup', onMouseUp, false);
	window.addEventListener('click', onClick, false);
	// Return cleanup function
	return () => {
		cancelAnimationFrame(animationFrameId); // Cancel the animation loop
		satelliteWorkers.forEach((worker) => worker.terminate());
		orbitWorker.terminate();
		window.removeEventListener('resize', resize);
		window.removeEventListener('mousemove', updateMouseCoordinates);
		window.removeEventListener('mousedown', onMouseDown);
		window.removeEventListener('mouseup', onMouseUp);
		window.removeEventListener('click', onClick);
	};
};

window.addEventListener('resize', resize);
