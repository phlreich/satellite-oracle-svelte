// satelliteWorker.js
import { propagate } from 'satellite.js';

/** @type {Float32Array | null} */
let satellitepositions = null;
/** @type {Array<{ satrec: any }> | null} */
let satelliteData = null;
/** @type {Uint8Array | null} */
let visibility = null;
/** @type {number[]} */
let indices = [];
let isRunning = false;

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const runLoop = async () => {
	while (true) {
		if (!satellitepositions || !satelliteData || !visibility) {
			await sleep(30);
			continue;
		}

		const currentTime = new Date();
		for (const i of indices) {
			if (visibility[i] > 0) {
				// we only need to update the positions of satellites that are visible
				const positionAndVelocity = propagate(satelliteData[i].satrec, currentTime);
				const position = positionAndVelocity.position;
				if (typeof position === 'object' && position !== null) {
					satellitepositions[i * 3] = position['y'];
					satellitepositions[i * 3 + 1] = position['z'];
					satellitepositions[i * 3 + 2] = position['x'];
				}
			}
		}
		// wait a little before updating the positions again
		await sleep(30);
	}
};

onmessage = (event) => {
	if (event.data?.type === 'init') {
		satellitepositions = event.data.satellitepositions;
		satelliteData = event.data.satelliteData;
		visibility = event.data.visibility;
		if (!isRunning) {
			isRunning = true;
			runLoop();
		}
		return;
	}

	if (event.data?.type === 'set-indices') {
		indices = Array.isArray(event.data.indices) ? event.data.indices : [];
	}
};
