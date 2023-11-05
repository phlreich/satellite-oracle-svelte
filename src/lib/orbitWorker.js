// @ts-nocheck
// orbitWorker.js
import { propagate } from 'satellite.js';

onmessage = async (event) => {
    const { satelliteIndex, satelliteData, satellites } = event.data;
    const orbitPoints = calculateOrbitPoints(satelliteIndex, satelliteData, satellites);
    postMessage(orbitPoints);
};

function calculateOrbitPoints(satelliteIndex, satelliteData, satellites) {
    const points = [];
    const now = new Date();
    const revolutionsPerDay = parseFloat(satellites[satelliteIndex][2].slice(52, 63));
    const minutesPerDay = 1440;
    const minutesPerRevolution = minutesPerDay / revolutionsPerDay;
    const timeStep = minutesPerRevolution / 100;

    for (let i = 0; i < 101; i++) {
        const propagationTime = new Date(now.getTime() + i * timeStep * 60 * 1000);
        const positionAndVelocity = propagate(satelliteData[satelliteIndex].satrec, propagationTime);
        points.push(positionAndVelocity.position);
    }

    return points;
}
