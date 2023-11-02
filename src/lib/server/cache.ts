// src/lib/server/cache.ts
let cache = {
    sceneData: null,
    lastUpdated: 0,
};

export function getCache() {
    return cache;
}

export function setCache(data: any) {
    cache = {
        sceneData: data,
        lastUpdated: Date.now(),
    };
    console.log('Cache updated');
}