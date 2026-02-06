// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
// orbitWorker.js
import { propagate } from 'satellite.js';

let satelliteData;

onmessage = function (event) {
	if (event.data.type === 'init') {
		satelliteData = event.data.satelliteData;
	} else if (event.data.type === 'process') {
		const satelliteIndex = event.data.satelliteIndex;
		const requestId = Number(event.data.requestId) || 0;
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
			requestId,
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
	const satrec = satelliteData?.[satelliteIndex]?.satrec;
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
