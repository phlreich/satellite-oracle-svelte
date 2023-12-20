import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { twoline2satrec } from 'satellite.js';
import Stats from 'three/examples/jsm/libs/stats.module.js';
import type { Writable } from 'svelte/store';

class ThrottledLogger {
	private lastMessage: string | null = null;
	private isReadyToLog: boolean = true;

	public log(message: string): void {
		if (this.isReadyToLog) {
			console.log(message);
			this.isReadyToLog = false;
			setTimeout(() => this.enableLogging(), 1000);
		} else {
			this.lastMessage = message; // Update the last message
		}
	}

	private enableLogging(): void {
		this.isReadyToLog = true;
		if (this.lastMessage !== null) {
			console.log(this.lastMessage);
			this.lastMessage = null;
			// Reset the timer
			setTimeout(() => this.enableLogging(), 1000);
		}
	}
}

// const logger = new ThrottledLogger();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
	75,
	window.innerWidth / window.innerHeight,
	0.1,
	1000000
);

const scale = 2 * 6356.7523;
camera.position.z = scale * 0.5;
camera.position.y = scale * 0.5;
camera.position.x = scale * 0.5;

let renderer: THREE.WebGLRenderer;
let animationFrameId: number;

const resolution = 100;
const earthRadius = 6356.7523;

const earthGeometry = new THREE.SphereGeometry(earthRadius, resolution, resolution);
const initialMaterial = new THREE.MeshBasicMaterial({ color: 0x005f9a });
const earthMesh = new THREE.Mesh(earthGeometry, initialMaterial);
scene.add(earthMesh);
const textureLoader = new THREE.TextureLoader();
textureLoader.load('/earth.webp', (texture) => {
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
        vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
        gl_PointSize = size * ( 20.0 / -mvPosition.z );
        gl_Position = projectionMatrix * mvPosition;
    }
  }
`;

const fragmentShader = `
    uniform vec3 color;
    uniform float alphaTest;
    
    varying vec3 vColor;
    
    void main() {
        float dist = length(gl_PointCoord - vec2(0.5));
    
        if (dist > 0.5) {
            discard;  // discard pixels outside the total point radius
        } else if (dist > 0.45) {  // if pixels are in the border region
            gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);  // color them black
        } else {  // for pixels inside the border
            gl_FragColor = vec4( color * vColor, 1.0 );
            if ( gl_FragColor.a < alphaTest ) discard;
        }
    }
`;

const satelliteMaterial = new THREE.ShaderMaterial({
	uniforms: {
		color: { value: new THREE.Color(0xffffff) },
		alphaTest: { value: 0.9 }
	},
	vertexShader: vertexShader,
	fragmentShader: fragmentShader
});

// axes helper
// const axesHelper = new THREE.AxesHelper(1000000);
// scene.add(axesHelper);

const stats = new Stats();
document.body.appendChild(stats.dom);

const resize = () => {
	renderer.setSize(window.innerWidth, window.innerHeight);
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
};

export const createScene = async (
	el: HTMLCanvasElement,
	satellites: any,
	selectedSatellite: Writable<any>,
	sharedData: Writable<any>
) => {
	let audioFlag = false;
	const playAudio = () => {
		audioFlag = false;
		const audio = new Audio('/threnody.mp3');
		audio.play();
	};

	const raycaster = new THREE.Raycaster();
	(raycaster.params as any).Points = { threshold: 20 };
	const mouse = new THREE.Vector2();

	let lastIntersect: number | undefined;
	renderer = new THREE.WebGLRenderer({ antialias: true, canvas: el });
	const controls = new OrbitControls(camera, renderer.domElement);
	controls.enableDamping = true;
	controls.dampingFactor = 0.1;

	// Optional: Adjust these for how fast the user can zoom/pan
	controls.zoomSpeed = 0.4;
	controls.panSpeed = 0.4;
	controls.rotateSpeed = 0.4;
	controls.maxDistance = 1000000;
	controls.minDistance = 7000;

	// initialize satellite positions
	const N = satellites.length;
	const sharedBufferPositions = new SharedArrayBuffer(N * 3 * Float32Array.BYTES_PER_ELEMENT);
	const sharedBuffervisibility = new SharedArrayBuffer(N * 1 * Float32Array.BYTES_PER_ELEMENT);
	const satellitepositions = new Float32Array(sharedBufferPositions);
	const visibility = new Float32Array(sharedBuffervisibility);

	const colors = new Float32Array(N * 3); // three components per color
	const sizes = new Float32Array(N); // one component per size
	for (let i = 0; i < N; i++) {
		colors[i * 3] = 1.0; // red
		colors[i * 3 + 1] = 1.0; // green
		colors[i * 3 + 2] = 1.0; // blue
		sizes[i] = 1000; // size
	}

	visibility.fill(1.0, 0, 3333);

	const satelliteData = satellites.map((sat: any) => {
		const [epoch, tleLine1, tleLine2, norad_cat_id] = sat;
		const satrec = twoline2satrec(tleLine1, tleLine2);
		const epochDate = new Date(epoch);
		return { satrec, epoch: epochDate, norad_cat_id };
	});
	const satelliteWorker1 = new Worker(new URL('./satelliteWorker.js', import.meta.url), {
		type: 'module'
	});
	const satelliteWorker2 = new Worker(new URL('./satelliteWorker.js', import.meta.url), {
		type: 'module'
	});

	const orbitWorker = new Worker(new URL('./orbitWorker.js', import.meta.url), { type: 'module' });

	orbitWorker.postMessage({ type: 'init', satelliteData, satellites });

	satelliteWorker1.postMessage({
		start: 0,
		end: (N / 2) | 0,
		satellitepositions,
		satelliteData,
		visibility
	});
	satelliteWorker2.postMessage({
		start: (N / 2) | 0,
		end: N,
		satellitepositions,
		satelliteData,
		visibility
	});

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(satellitepositions, 3));
	geometry.setAttribute('customColor', new THREE.BufferAttribute(colors, 3));
	geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
	geometry.setAttribute('visibility', new THREE.BufferAttribute(visibility, 1));
	const points = new THREE.Points(geometry, satelliteMaterial);
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
			const orbit = new THREE.Line(geometry, material);
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
		const points = [];
		points.push(new THREE.Vector3(0, 0, 0));
		points.push(new THREE.Vector3(
			satellitepositions[satelliteIndex * 3],
			satellitepositions[satelliteIndex * 3 + 1],
			satellitepositions[satelliteIndex * 3 + 2]
		));
		const geometry = new THREE.BufferGeometry().setFromPoints(points);
		let line = new THREE.Line(geometry, material);
		line.name = 'verticalLine';
		scene.add(line);
	}

	function hoverColor() {
		raycaster.setFromCamera(mouse, camera);
		let intersects = raycaster.intersectObjects(scene.children, true);
		let index = intersects.findIndex(intersect => intersect.object.type === 'Points');

		if (index !== -1) {
			const satelliteIndex = intersects[index].index as number;
			const color = geometry.attributes['customColor'] as THREE.BufferAttribute;
			color.setXYZ(satelliteIndex, 0.0, 1.0, 0.0);
			color.needsUpdate = true;
			if (lastIntersect) {
				if (lastIntersect !== satelliteIndex) {
					resetLast(lastIntersect);
				}
			}
			lastIntersect = satelliteIndex;
		} else {
			if (lastIntersect) {
				resetLast(lastIntersect);
			}
			lastIntersect = undefined;
		}
	}
	let localSelectedSatellite: any;
	function handleShortClick(event: any) {
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
			satrec: satelliteData[index].satrec,
		});
		localSelectedSatellite = index;
		color.needsUpdate = true;

		lerpTarget = {
			type: 'satellite',
			indeces: [index * 3, index * 3 + 1, index * 3 + 2],
			position: undefined
		};
		[index * 3, index * 3 + 1, index * 3 + 2];
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
	let mouseDownEvent: any;
	function onMouseDown(event: any) {
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
		if (duration < shortClickDuration) {
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

	sharedData.subscribe((data) => {
		if (data[1] === 'show_objects') {
			for (let i = 0; i < N; i++) {
				const noradID = satelliteData[i].norad_cat_id;
				// Check if noradID is present in any of the objects in data[0]
				if (data[0].some((item: { NORAD_CAT_ID: any }) => item.NORAD_CAT_ID === noradID)) {
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
				if (data[0].some((item: { NORAD_CAT_ID: any }) => item.NORAD_CAT_ID === noradID)) {
					visibility[i] = 1.0;
					// console.log('drawing orbit for', noradID);
					drawOrbit(i);
				}
			}
		}
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
	const EARTH_ROTATION_PERIOD = 23.9345 * 60 * 60; // Sidereal day in seconds (23 hours, 56 minutes, 4.1 seconds)
	const DEGREES_PER_SECOND = 360 / EARTH_ROTATION_PERIOD;
	const now = new Date();
	const midnightUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
	const animate = () => {
		const onAnimationFrame = async () => {
			stats.update();
			const currentTime = new Date().getTime();
			const delta = (currentTime - midnightUTC.getTime()) / 1000;
			const rotationAngle = (delta * DEGREES_PER_SECOND) % 360;
			earthMesh.rotation.y = THREE.MathUtils.degToRad(rotationAngle - 19.4);
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
			if (localSelectedSatellite) {
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
		window.removeEventListener('resize', resize);
		window.removeEventListener('mousemove', updateMouseCoordinates);
		window.removeEventListener('mousedown', onMouseDown);
		window.removeEventListener('mouseup', onMouseUp);
		window.removeEventListener('click', onClick);
	};
};

window.addEventListener('resize', resize);
