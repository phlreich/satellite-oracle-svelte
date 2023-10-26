import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { sgp4, twoline2satrec } from 'satellite.js';
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
const earthGeometry = new THREE.SphereGeometry(
    earthRadius,
    resolution,
    resolution
);
const earthTexture = new THREE.TextureLoader().load(
    '/earth.webp'
);
earthTexture.colorSpace = THREE.SRGBColorSpace;
const earthMaterial = new THREE.MeshBasicMaterial({ map: earthTexture });
const earthMesh = new THREE.Mesh(earthGeometry, earthMaterial);
scene.add(earthMesh);

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

const stats = new Stats();
document.body.appendChild(stats.dom);

const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
};

export const createScene = (el: HTMLCanvasElement, satellites: any) => {
    const raycaster = new THREE.Raycaster();
    (raycaster.params as any).Points = { threshold: 35 };
    const mouse = new THREE.Vector2();

    let lastIntersect: number | undefined;
    let lastClicked: number | undefined;
    renderer = new THREE.WebGLRenderer({ antialias: true, canvas: el });
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.maxDistance = 1000000;

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
        const satrec = twoline2satrec(sat['TLE_LINE1'], sat['TLE_LINE2']);
        const epoch = new Date(sat['EPOCH']);
        return { satrec, epoch };
    });
    const satelliteWorker = new Worker(new URL('./satelliteWorker.js', import.meta.url), { type: 'module' });
    satelliteWorker.postMessage({ N, satellitepositions, satelliteData });

    // destroy satellites
    satellites = undefined;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(satellitepositions, 3));
    geometry.setAttribute('customColor', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    const points = new THREE.Points(geometry, satelliteMaterial);
    scene.add(points);

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

    function onMouseClick(event: any) {
        mouse.x = (event.clientX / renderer.domElement.clientWidth) * 2 - 1;
        mouse.y = -(event.clientY / renderer.domElement.clientHeight) * 2 + 1;

        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObjects(scene.children, true);
        if (intersects.length > 0) {
            const index = intersects[0].index as number;
            const color = geometry.attributes[
                'customColor'
            ] as THREE.BufferAttribute;
            color.setXYZ(index, 0.0, 1.0, 0.0);

            color.needsUpdate = true;

            lastClicked = index;
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

    const updateSatellitePositions = () => {
        const currentTime = new Date().getTime();
        for (let i = 0; i < N; i++) {
            const timeSinceEpoch = (currentTime - satelliteData[i].epoch.getTime()) / (1000 * 60);
            const positionAndVelocity = sgp4(satelliteData[i].satrec, timeSinceEpoch);
            const position = positionAndVelocity.position;
            if (typeof position === 'object' && position !== null) {
                satellitepositions[i * 3] = position["x"];
                satellitepositions[i * 3 + 1] = position["z"];
                satellitepositions[i * 3 + 2] = position["y"];
            }
        }
    };

    const animate = () => {
        const onAnimationFrame = () => {
            stats.update();
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
    window.addEventListener('click', onMouseClick, false);
    // Return cleanup function
    return () => {
        cancelAnimationFrame(animationFrameId); // Cancel the animation loop
        window.removeEventListener('resize', resize);
        window.removeEventListener('mousemove', updateMouseCoordinates);
        window.removeEventListener('click', onMouseClick);
    };
};

window.addEventListener('resize', resize);
