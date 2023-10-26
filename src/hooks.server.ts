// src/hooks.server.ts
import { checkpoint, updateBoxscore, updateCSVs, updateGP, updateSatcat, initializeDatabase } from '$lib/server/database.server';
import { scheduleJob } from 'node-schedule';
import { EMAIL, PASSWORD } from '$env/static/private';

initializeDatabase();

const job = scheduleJob('38 1 * * *', async function () {
    let startTime = new Date().getTime();
    console.log('running database refresh node cron job at time: ', startTime);
    await updateCSVs(EMAIL, PASSWORD);
    await updateSatcat();
    await updateBoxscore();
    await updateGP();
    await checkpoint();
    let endTime = new Date().getTime();
    console.log('finished database refresh node cron job at time: ', endTime);
    let timeTaken = (endTime - startTime) / 1000;
    console.log('Time taken:', timeTaken, 'seconds');
});