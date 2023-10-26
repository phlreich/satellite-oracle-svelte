// satelliteWorker.js
import { sgp4 } from 'satellite.js';

onmessage = (event) => {
    if (event.data.satellitepositions && event.data.satelliteData) {
        while (true) {
            const currentTime = new Date().getTime();
            for (let i = 0; i < event.data.N; i++) {
                //const currentTime = new Date().getTime();
                const timeSinceEpoch = (currentTime - event.data.satelliteData[i].epoch.getTime()) / (1000 * 60);
                const positionAndVelocity = sgp4(event.data.satelliteData[i].satrec, timeSinceEpoch);
                const position = positionAndVelocity.position;
                if (typeof position === 'object' && position !== null) {
                    event.data.satellitepositions[i * 3] = position["x"];
                    event.data.satellitepositions[i * 3 + 1] = position["z"];
                    event.data.satellitepositions[i * 3 + 2] = position["y"];
                }
            }
        }
    }
};