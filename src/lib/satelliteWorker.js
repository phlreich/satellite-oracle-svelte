// satelliteWorker.js
import { propagate, twoline2satrec } from 'satellite.js';

/** @type {Float32Array | null} */
let previousSatellitePositions = null;
/** @type {Float32Array | null} */
let previousSatelliteVelocities = null;
/** @type {Float64Array | null} */
let previousSatelliteUpdateTimes = null;
/** @type {Float32Array | null} */
let currentSatellitePositions = null;
/** @type {Float32Array | null} */
let currentSatelliteVelocities = null;
/** @type {Float64Array | null} */
let currentSatelliteUpdateTimes = null;
/** @type {Array<{ tleLine1: string, tleLine2: string, satrec?: any }> | null} */
let satelliteData = null;
/** @type {Uint8Array | null} */
let computeVisibility = null;
/** @type {number[]} */
let indices = [];
let isRunning = false;
let isPaused = false;
let updateIntervalMs = 250;
let workerId = -1;
let rotationOffset = 0;

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {number} index */
const getSatrec = (index) => {
	const satellite = satelliteData?.[index];
	if (!satellite) {
		return null;
	}
	if (!satellite.satrec) {
		satellite.satrec = twoline2satrec(satellite.tleLine1, satellite.tleLine2);
	}
	return satellite.satrec;
};

const runLoop = async () => {
	while (true) {
		if (isPaused) {
			await sleep(250);
			continue;
		}

		if (
			!previousSatellitePositions ||
			!previousSatelliteVelocities ||
			!previousSatelliteUpdateTimes ||
			!currentSatellitePositions ||
			!currentSatelliteVelocities ||
			!currentSatelliteUpdateTimes ||
			!satelliteData ||
			!computeVisibility
		) {
			await sleep(50);
			continue;
		}

		const currentTime = new Date();
		const currentTimeMs = currentTime.getTime();
		const loopStartMs = performance.now();
		let updatedCount = 0;
		for (let step = 0; step < indices.length; step++) {
			const orderedIndex = (step + rotationOffset) % indices.length;
			const i = indices[orderedIndex];
			if (computeVisibility[i] > 0) {
				// we only need to update the positions of satellites that are visible
				const satrec = getSatrec(i);
				if (!satrec) {
					continue;
				}
				const positionAndVelocity = propagate(satrec, currentTime);
				if (!positionAndVelocity) {
					continue;
				}
				const position = positionAndVelocity.position;
				const velocity = positionAndVelocity.velocity;
				if (
					typeof position === 'object' &&
					position !== null &&
					typeof velocity === 'object' &&
					velocity !== null
				) {
					const vectorIndex = i * 3;
					previousSatellitePositions[vectorIndex] = currentSatellitePositions[vectorIndex];
					previousSatellitePositions[vectorIndex + 1] = currentSatellitePositions[vectorIndex + 1];
					previousSatellitePositions[vectorIndex + 2] = currentSatellitePositions[vectorIndex + 2];
					previousSatelliteVelocities[vectorIndex] = currentSatelliteVelocities[vectorIndex];
					previousSatelliteVelocities[vectorIndex + 1] =
						currentSatelliteVelocities[vectorIndex + 1];
					previousSatelliteVelocities[vectorIndex + 2] =
						currentSatelliteVelocities[vectorIndex + 2];
					previousSatelliteUpdateTimes[i] = currentSatelliteUpdateTimes[i];

					currentSatellitePositions[vectorIndex] = position['y'];
					currentSatellitePositions[vectorIndex + 1] = position['z'];
					currentSatellitePositions[vectorIndex + 2] = position['x'];
					currentSatelliteVelocities[vectorIndex] = velocity['y'];
					currentSatelliteVelocities[vectorIndex + 1] = velocity['z'];
					currentSatelliteVelocities[vectorIndex + 2] = velocity['x'];
					currentSatelliteUpdateTimes[i] = currentTimeMs;
					updatedCount += 1;
				}
			}
		}
		if (indices.length > 0) {
			rotationOffset = (rotationOffset + 1) % indices.length;
		}
		postMessage({
			type: 'loop-stats',
			workerId,
			assignedCount: indices.length,
			updatedCount,
			loopMs: performance.now() - loopStartMs,
			finishedAtMs: currentTimeMs
		});
		await sleep(updateIntervalMs);
	}
};

onmessage = (event) => {
	if (event.data?.type === 'init') {
		previousSatellitePositions = event.data.previousSatellitePositions;
		previousSatelliteVelocities = event.data.previousSatelliteVelocities;
		previousSatelliteUpdateTimes = event.data.previousSatelliteUpdateTimes;
		currentSatellitePositions = event.data.currentSatellitePositions;
		currentSatelliteVelocities = event.data.currentSatelliteVelocities;
		currentSatelliteUpdateTimes = event.data.currentSatelliteUpdateTimes;
		satelliteData = event.data.satelliteData;
		computeVisibility = event.data.computeVisibility ?? event.data.visibility;
		const receivedWorkerId = Number(event.data.workerId);
		workerId = Number.isFinite(receivedWorkerId) ? receivedWorkerId : -1;
		if (!isRunning) {
			isRunning = true;
			runLoop();
		}
		return;
	}

	if (event.data?.type === 'set-indices') {
		indices = Array.isArray(event.data.indices) ? event.data.indices : [];
		if (indices.length === 0) {
			rotationOffset = 0;
		} else {
			rotationOffset %= indices.length;
		}
		return;
	}

	if (event.data?.type === 'set-update-interval') {
		const requestedInterval = Number(event.data.intervalMs);
		if (Number.isFinite(requestedInterval)) {
			updateIntervalMs = Math.max(50, requestedInterval);
		}
		return;
	}

	if (event.data?.type === 'set-paused') {
		isPaused = Boolean(event.data.paused);
	}
};
