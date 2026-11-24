// A mobile connection can stall without rejecting fetch. Let the screen offer a retry
// and ignore a late response to the expired read.
export function withNetworkTimeout<T>(request: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TypeError('Network request timed out')), 30_000);
    request.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
