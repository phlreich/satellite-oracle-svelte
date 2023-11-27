// Utility function to detect mobile device
export function isMobile(userAgent: string | null): boolean {
    if (!userAgent) return false;
    return /android|avantgo|blackberry|iphone|ipod|iemobile|opera mini|palmos|webos|googlebot-mobile/i.test(userAgent);
  }
  