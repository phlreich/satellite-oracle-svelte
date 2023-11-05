import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { twoline2satrec, eciToGeodetic, gstime, propagate } from 'satellite.js';
import Stats from 'three/examples/jsm/libs/stats.module.js';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    1000000);

const scale = 2 * 6356.7523;
camera.position.z = scale;
camera.position.y = scale;
camera.position.x = scale;

let renderer: THREE.WebGLRenderer;
let animationFrameId: number;

const resolution = 100;
const earthRadius = 6356.7523;

const earthGeometry = new THREE.SphereGeometry(earthRadius, resolution, resolution);
const initialMaterial = new THREE.MeshBasicMaterial({ color: 0x005f9a });
const earthMesh = new THREE.Mesh(earthGeometry, initialMaterial);
scene.add(earthMesh);
const textureLoader = new THREE.TextureLoader();
textureLoader.load('/earth-compressed.webp', (texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    earthMesh.material = new THREE.MeshBasicMaterial({ map: texture });
    earthMesh.material.needsUpdate = true;
});


const vertexShader = `
  attribute float size;
  attribute vec3 customColor;

  varying vec3 vColor;

  void main() {
    vColor = customColor;

    vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );

    gl_PointSize = size * ( 20.0 / -mvPosition.z );

    gl_Position = projectionMatrix * mvPosition;
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
        alphaTest: { value: 0.9 },
    },
    vertexShader: vertexShader,
    fragmentShader: fragmentShader,
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

export const createScene = (el: HTMLCanvasElement, satellites: any) => {
    const raycaster = new THREE.Raycaster();
    (raycaster.params as any).Points = { threshold: 25 };
    const mouse = new THREE.Vector2();

    let lastIntersect: number | undefined;
    let lastClicked: number | undefined;
    renderer = new THREE.WebGLRenderer({ antialias: true, canvas: el });
    const controls = new OrbitControls(camera, renderer.domElement);
    // Enable damping (inertia) and set the damping factor
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // Optional: Adjust these for how fast the user can zoom/pan
    controls.zoomSpeed = 1.0;
    controls.panSpeed = 1.0;
    controls.maxDistance = 1000000;
    controls.minDistance = 7000;

    // initialize satellite positions
    const N = satellites.length;
    const sharedBuffer = new SharedArrayBuffer(N * 3 * Float32Array.BYTES_PER_ELEMENT);
    const satellitepositions = new Float32Array(sharedBuffer);
    const colors = new Float32Array(N * 3); // three components per color
    const sizes = new Float32Array(N); // one component per size
    for (let i = 0; i < N; i++) {
        colors[i * 3] = 1.0; // red
        colors[i * 3 + 1] = 1.0; // green
        colors[i * 3 + 2] = 1.0; // blue
        sizes[i] = 1000; // size
    }

    const satelliteData = satellites.map((sat: any) => {
        const [epoch, tleLine1, tleLine2] = sat;
        const satrec = twoline2satrec(tleLine1, tleLine2);
        const epochDate = new Date(epoch);
        return { satrec, epoch: epochDate };
    });
    const satelliteWorker1 = new Worker(new URL('./satelliteWorker.js', import.meta.url), { type: 'module' });
    const satelliteWorker2 = new Worker(new URL('./satelliteWorker.js', import.meta.url), { type: 'module' });

    const orbitWorker = new Worker(new URL('./orbitWorker.js', import.meta.url), { type: 'module' });

    satelliteWorker1.postMessage({ start: 0, end: N / 2 | 0, satellitepositions, satelliteData });
    satelliteWorker2.postMessage({ start: N / 2 | 0, end: N, satellitepositions, satelliteData });

    // destroy satellites
    // satellites = undefined;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(satellitepositions, 3));
    geometry.setAttribute('customColor', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    const points = new THREE.Points(geometry, satelliteMaterial);
    scene.add(points);

    function drawOrbit(satelliteIndex: number) {
        orbitWorker.postMessage({ satelliteIndex, satelliteData, satellites });
        orbitWorker.onmessage = (event) => {
            const orbitPoints = event.data.map((point: { x: number; y: number; z: number; }) => new THREE.Vector3(point.y, point.z, point.x));
            const geometry = new THREE.BufferGeometry().setFromPoints(orbitPoints);
            const material = new THREE.LineBasicMaterial({ color: 0x90EE90 });
            const orbit = new THREE.Line(geometry, material);
            // remove old orbit
            scene.children.forEach((child) => {
                if (child.type === 'Line') {
                    scene.remove(child);
                }
            });

            scene.add(orbit);
        };
    }
    (window as any).satelliteData = satelliteData;
    (window as any).satellites = satellites;
    function hoverColor() {

        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObjects(scene.children, true);

        if (intersects.length > 0) {
            if (intersects[0].object.type === 'Points') {
                const index = intersects[0].index as number;
                const color = geometry.attributes[
                    'customColor'
                ] as THREE.BufferAttribute;
                color.setXYZ(index, 0.0, 1.0, 0.0);
                color.needsUpdate = true;
            }
            if (lastIntersect) {
                if (lastIntersect !== intersects[0].index) {
                    resetLast(lastIntersect);
                }
            }
            lastIntersect = intersects[0].index;
        } else {
            if (lastIntersect) {
                resetLast(lastIntersect);
            }
            lastIntersect = undefined;
        }
    }

    function handleShortClick(event: any) {

        //console.log('click')
        controls.minDistance = 0;

        mouse.x = (event.clientX / renderer.domElement.clientWidth) * 2 - 1;
        mouse.y = -(event.clientY / renderer.domElement.clientHeight) * 2 + 1;

        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObjects(scene.children, true);
        if (intersects.length > 0 && intersects[0].object.type === 'Points') {
            const index = intersects[0].index as number;
            const color = geometry.attributes[
                'customColor'
            ] as THREE.BufferAttribute;
            color.setXYZ(index, 0.0, 1.0, 0.0);
            console.log(satellites[index].slice(-1)[0])
            const currentTime = new Date();
            const timeSinceTleEpochMinutes = (currentTime.getTime() - satelliteData[index].epoch.getTime()) / (1000 * 60);
            //@ts-ignore
            const positionGd = eciToGeodetic(propagate(satelliteData[index].satrec, currentTime).position, gstime(currentTime));
            //@ts-ignore
            //console.log('lat', positionGd['latitude'] * 57, 2958)
            ////@ts-ignore
            //console.log('lon', positionGd['longitude'] * 57, 2958)
            ////@ts-ignore
            //console.log('alt', positionGd['height'])
            color.needsUpdate = true;

            lastClicked = index;

            drawOrbit(index);
        }
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

    function onMouseUp() {
        const duration = new Date().getTime() - startTime;
        const shortClickDuration = 150;

        if (duration < shortClickDuration) {
            // It's a short click
            handleShortClick(mouseDownEvent);
        }
    }

    function onClick(event: any) {
        if (!event.isMouseDown || !event.isMouseUp) {
            // It's a short click
            handleShortClick(mouseDownEvent);
        }
    }

    const updateSatellitePositions = () => {
        const currentTime = new Date(); 
        for (let i = 0; i < N; i++) {
            const positionAndVelocity = propagate(satelliteData[i].satrec, currentTime);
            const position = positionAndVelocity.position;
            if (typeof position === 'object' && position !== null) {
                satellitepositions[i * 3] = position["y"];
                satellitepositions[i * 3 + 1] = position["z"];
                satellitepositions[i * 3 + 2] = position["x"];
            }
        }
    };
    // Constants for Earth's rotation
    const EARTH_ROTATION_PERIOD = 23.9345 * 60 * 60; // Sidereal day in seconds (23 hours, 56 minutes, 4.1 seconds)
    const DEGREES_PER_SECOND = 360 / EARTH_ROTATION_PERIOD;
    const REFERENCE_TIME = new Date().setUTCHours(0, 0, 0, 0); // Set to the most recent midnight UTC

    const animate = () => {
        const onAnimationFrame = () => {
            stats.update();
            const currentTime = new Date().getTime();
            const delta = (currentTime - REFERENCE_TIME) / 1000;
            const rotationAngle = (delta * DEGREES_PER_SECOND) % 360;
            earthMesh.rotation.y = THREE.MathUtils.degToRad(rotationAngle - 45);
            earthGeometry.attributes.position.needsUpdate = true;
            geometry.attributes.position.needsUpdate = true;
            hoverColor();
            if (lastClicked) {
                controls.target.lerp(new THREE.Vector3(
                    satellitepositions[lastClicked as number * 3],
                    satellitepositions[lastClicked as number * 3 + 1],
                    satellitepositions[lastClicked as number * 3 + 2]
                ), 0.1);
            }
            controls.update();
            renderer.render(scene, camera);
            animationFrameId = requestAnimationFrame(onAnimationFrame);
        };
        animationFrameId = requestAnimationFrame(onAnimationFrame);
    };
    resize();
    // TODO find out why removing the following line breaks hovercolor and click
    updateSatellitePositions();
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
