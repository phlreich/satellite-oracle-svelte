import { initializeDatabaseAndSetCache } from './database.server';

let startupInitializationPromise: Promise<void> | undefined;

export function triggerStartupInitialization(): Promise<void> {
	if (!startupInitializationPromise) {
		startupInitializationPromise = initializeDatabaseAndSetCache();
	}
	return startupInitializationPromise;
}

export function waitForStartupInitialization(): Promise<void> {
	return triggerStartupInitialization();
}
