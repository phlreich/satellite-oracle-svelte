// src/hooks.ts
import { updateSatcat} from '$lib/server/database';
import { scheduleJob } from 'node-schedule';

const job = scheduleJob('*/1 * * * *', function () {
    console.log('This runs every minute')
})