// @ts-nocheck
// orbitWorker.js
import { propagate } from 'satellite.js';

onmessage = async (event) => {
    const { satelliteIndex, satelliteData, satellites } = event.data;
    const orbitPoints = calculateOrbitPoints(satelliteIndex, satelliteData, satellites);
    postMessage(orbitPoints);
};

function calculateOrbitPoints(satelliteIndex, satelliteData, satellites) {
    // Calculate the orbit points for the satellite in steps of 1% of the orbital period
    // TODO: This is a bit of a hack, but it works for now.  Need to find a better way to do this.
    // It means that highly eccentric orbits will have a lower resolution than circular orbits.
    const points = [];
    const now = new Date();
    const revolutionsPerDay = parseFloat(satellites[satelliteIndex][2].slice(52, 63));
    const minutesPerDay = 1440;
    const minutesPerRevolution = minutesPerDay / revolutionsPerDay;
    const timeStep = minutesPerRevolution / 100;

    for (let i = 0; i < 102; i++) {
        const propagationTime = new Date(now.getTime() + i * timeStep * 60 * 1000);
        const positionAndVelocity = propagate(satelliteData[satelliteIndex].satrec, propagationTime);
        points.push(positionAndVelocity.position);
    }

    return points;
}
