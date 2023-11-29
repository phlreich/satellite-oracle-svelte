// @ts-nocheck
// orbitWorker.js
import { propagate } from 'satellite.js';

let satelliteData, satellites;

onmessage = function (event) {
    if (event.data.type === 'init') {
        // Store the constant data when the worker is initialized
        satelliteData = event.data.satelliteData;
        satellites = event.data.satellites;
    } else if (event.data.type === 'process') {
        const satelliteIndex = event.data.satelliteIndex;
        const orbitPoints = calculateOrbitPoints(satelliteIndex);
        postMessage(orbitPoints);
    }
};

function calculateOrbitPoints(satelliteIndex) {
    // Calculate the orbit points for the satellite in steps of 1% of the orbital period
    // TODO: This is a bit of a hack, but it works for now.  Need to find a better way to do this.
    // It means that highly eccentric orbits will have a lower resolution than circular orbits.
    const points = [];
    const now = new Date().getTime();
    const tenMinutesAgo = now - 10 * 60 * 1000;
    const revolutionsPerDay = parseFloat(satellites[satelliteIndex][2].slice(52, 63));
    const minutesPerDay = 1440;
    const minutesPerRevolution = minutesPerDay / revolutionsPerDay;
    const timeStep = minutesPerRevolution / 100;
    for (let i = 0; i < 101; i++) {
        const propagationTime = new Date(tenMinutesAgo + i * timeStep * 60 * 1000);
        const positionAndVelocity = propagate(satelliteData[satelliteIndex].satrec, propagationTime);
        points.push(positionAndVelocity.position);
    }

    return points;
}
