// satelliteWorker.js
import { propagate } from 'satellite.js';

onmessage = async (event) => {
    if (event.data.satellitepositions && event.data.satelliteData) {
        while (true) {
            const currentTime = new Date();
            for (let i = event.data.start; i < event.data.end; i++) {
                const positionAndVelocity = propagate(event.data.satelliteData[i].satrec, currentTime);
                const position = positionAndVelocity.position;
                if (typeof position === 'object' && position !== null) {
                    event.data.satellitepositions[i * 3] = position["y"];
                    event.data.satellitepositions[i * 3 + 1] = position["z"];
                    event.data.satellitepositions[i * 3 + 2] = position["x"];
                }
            }
            // wait a little before updating the positions again
            await new Promise(r => setTimeout(r, 30));
        }
    }
};