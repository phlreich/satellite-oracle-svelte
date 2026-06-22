// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
// orbitWorker.js
import { propagate, twoline2satrec } from 'satellite.js';

let satelliteData;

function getSatrec(satelliteIndex) {
	const satellite = satelliteData?.[satelliteIndex];
	if (!satellite) {
		return null;
	}
	if (!satellite.satrec) {
		satellite.satrec = twoline2satrec(satellite.tleLine1, satellite.tleLine2);
	}
	return satellite.satrec;
}

onmessage = function (event) {
	if (event.data.type === 'init') {
		const capacity = Number(event.data.capacity);
		satelliteData = Array.isArray(event.data.satelliteData)
			? event.data.satelliteData
			: new Array(Number.isFinite(capacity) ? capacity : 0);
	} else if (event.data.type === 'add-satellites') {
		if (!satelliteData) {
			return;
		}
		const startIndex = Number(event.data.startIndex);
		const rows = Array.isArray(event.data.satelliteData) ? event.data.satelliteData : [];
		if (!Number.isInteger(startIndex) || startIndex < 0) {
			return;
		}
		for (let offset = 0; offset < rows.length; offset++) {
			satelliteData[startIndex + offset] = rows[offset];
		}
	} else if (event.data.type === 'process') {
		const kind = event.data.kind === 'overlay' ? 'overlay' : 'focus';
		const satelliteIndex = event.data.satelliteIndex;
		const requestId = Number(event.data.requestId) || 0;
		const generation = Number(event.data.generation) || 0;
		const startTimeMs = Number(event.data.startTimeMs) || Date.now();
		const sampleCount = Math.max(24, Number(event.data.sampleCount) || 360);
		const closeLoop = Boolean(event.data.closeLoop);
		const centerAroundStartTime = Boolean(event.data.centerAroundStartTime);
		const orbitPoints = calculateOrbitPoints({
			satelliteIndex,
			startTimeMs,
			sampleCount,
			closeLoop,
			centerAroundStartTime
		});
		postMessage({
			type: 'orbit-points',
			kind,
			requestId,
			generation,
			satelliteIndex,
			points: orbitPoints
		});
	}
};

function calculateOrbitPoints({
	satelliteIndex,
	startTimeMs,
	sampleCount,
	closeLoop,
	centerAroundStartTime
}) {
	const points = [];
	const satrec = getSatrec(satelliteIndex);
	if (!satrec) {
		return points;
	}
	const meanMotionRadPerMinute = Number(satrec?.no);
	const defaultPeriodMinutes = 90;
	const orbitalPeriodMinutes =
		Number.isFinite(meanMotionRadPerMinute) && meanMotionRadPerMinute > 0
			? (2 * Math.PI) / meanMotionRadPerMinute
			: defaultPeriodMinutes;
	const orbitalPeriodMs = orbitalPeriodMinutes * 60 * 1000;
	const effectiveStartTimeMs = centerAroundStartTime
		? startTimeMs - orbitalPeriodMs / 2
		: startTimeMs;

	for (let i = 0; i < sampleCount; i++) {
		const t = effectiveStartTimeMs + (i / sampleCount) * orbitalPeriodMs;
		const propagationTime = new Date(t);
		const positionAndVelocity = propagate(satrec, propagationTime);
		const position = positionAndVelocity.position;
		if (position && typeof position === 'object') {
			points.push(position);
		}
	}

	if (closeLoop && points.length > 0) {
		const firstPoint = points[0];
		points.push({ x: firstPoint.x, y: firstPoint.y, z: firstPoint.z });
	}

	return points;
}
