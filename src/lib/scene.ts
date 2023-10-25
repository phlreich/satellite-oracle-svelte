import {
    BoxGeometry,
    DirectionalLight,
    HemisphereLight,
    Mesh,
    MeshStandardMaterial,
    PerspectiveCamera,
    Scene,
    WebGLRenderer,
    SphereGeometry,
    TextureLoader,
    SRGBColorSpace,
    MeshBasicMaterial,
    BufferGeometry,
    ShaderMaterial,
    BufferAttribute,
    Color,
    Points
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';

import { sgp4, twoline2satrec } from 'satellite.js';

// import gpData from '../data/gp.json';
// const data: any[] = gpData as any[];

const scene = new Scene();
const camera = new PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    1000000);

const scale = 2 * 6356.7523;
camera.position.z = scale;
camera.position.y = scale;
camera.position.x = scale;

let renderer: WebGLRenderer;
let animationFrameId: number;



// console.log(data.slice(0, 3));
// 
// let satellites = [];
// for (let i = 0; i < data.length; i++) {
//     const satrec = twoline2satrec(data[i]['TLE_LINE1'], data[i]['TLE_LINE2']);
//     const positionAndVelocity = sgp4(satrec, 0);
//     const position = positionAndVelocity.position;
//     if (typeof position === 'object' && position !== null) {
//         satellites.push(position); // push the position object, not positionAndVelocity
//     }
// }
// const epochs = new Float32Array(data.length);
// for (let i = 0; i < data.length; i++) {
//     const epco = data[i]['EPOCH'];
// }


// (window as any).satellites = satellites;

const resolution = 100;
const earthRadius = 6356.7523;
// add the earth
const earthGeometry = new SphereGeometry(
    earthRadius,
    resolution,
    resolution
);
const earthTexture = new TextureLoader().load(
    '/earth.webp'
);
earthTexture.colorSpace = SRGBColorSpace;
const earthMaterial = new MeshBasicMaterial({ map: earthTexture });
const earthMesh = new Mesh(earthGeometry, earthMaterial);
scene.add(earthMesh);
// const N = satellites.length;
// 
// const satellitepositions = new Float32Array(satellites.length * 3); // three components per position
// for (let i = 0; i < satellites.length; i++) {
//     satellitepositions[i * 3] = satellites[i]["x"];
//     satellitepositions[i * 3 + 1] = satellites[i]["z"];
//     satellitepositions[i * 3 + 2] = satellites[i]["y"];
// }
// // Create a BufferGeometry and set its 'position' attribute
// const geometry = new BufferGeometry();
// geometry.setAttribute('position', new BufferAttribute(satellitepositions, 3));
// 
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

// Create a PointsMaterial for our points
const material = new ShaderMaterial({
    uniforms: {
        color: { value: new Color(0xffffff) },
        alphaTest: { value: 0.9 },
    },
    vertexShader: vertexShader,
    fragmentShader: fragmentShader,
});
// const colors = new Float32Array(N * 3); // three components per color
// const sizes = new Float32Array(N); // one component per size
// 
// for (let i = 0; i < N; i++) {
//     colors[i * 3] = 1.0; // red
//     colors[i * 3 + 1] = 1.0; // green
//     colors[i * 3 + 2] = 1.0; // blue
//     sizes[i] = 1000; // size
// }
// 
// geometry.setAttribute('customColor', new BufferAttribute(colors, 3));
// geometry.setAttribute('size', new BufferAttribute(sizes, 1));
// 
// const points = new Points(geometry, material);
// scene.add(points);


const animate = () => {
    animationFrameId = requestAnimationFrame(animate);
    // cube.rotation.x += 0.01;
    // cube.rotation.y += 0.01;
    renderer.render(scene, camera);
};

const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
};

export const createScene = (el: HTMLCanvasElement) => {
    renderer = new WebGLRenderer({ antialias: true, canvas: el });
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.maxDistance = 100000;
    resize();
    animate();

    // Return cleanup function
    return () => {
        cancelAnimationFrame(animationFrameId); // Cancel the animation loop
        window.removeEventListener('resize', resize); // Remove the resize event listener
    };
};

window.addEventListener('resize', resize);
