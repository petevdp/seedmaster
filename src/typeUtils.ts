export function isPartialPopulated(partial: Partial<unknown>, keys: string[]): boolean {
  for (let key of keys) {
    if (partial[key] === undefined) false;
  }
  return true;
}


export function ensurePartialPopulated<T>(partial: Partial<T>, keys: string[]): T {
  if (isPartialPopulated(partial, keys)) return partial as T;
  throw new  Error('partial is unpopulated: ' + JSON.stringify(partial));
}
